import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  activities as seedActivities,
  activityFeed as seedActivityFeed,
  approvalQueue as seedApprovals,
  seedArtifacts,
  workshop as seedWorkshop,
  type ActivityFeedItem,
  type ActivityLink,
  type ActivityRow,
  type ActivityStatus,
  type ApprovalItem,
  type Artifact,
  type Role,
  type SwotCategory,
  type WorkshopRecord,
  type WorkshopStatus,
} from "./workshop-data";

interface WorkshopContextValue {
  role: Role;
  setRole: (r: Role) => void;
  currentUser: string;
  workshop: WorkshopRecord;
  updateWorkshop: (patch: Partial<Pick<WorkshopRecord, "name" | "objective" | "tags">>) => void;
  setWorkshopStatus: (status: WorkshopStatus) => void;
  artifacts: Artifact[];
  activities: ActivityRow[];
  approvals: ApprovalItem[];
  activityFeed: ActivityFeedItem[];
  pendingApprovals: number;
  decideApproval: (id: string, decision: "approved" | "rejected", note?: string) => void;
  resetApproval: (id: string) => void;
  votesUsed: number;
  votesRemaining: number;
  voteAllocation: number;
  addArtifact: (input: { category: SwotCategory; title: string; description: string; tags: string[] }) => void;
  updateArtifact: (id: string, patch: Partial<Pick<Artifact, "title" | "description" | "tags" | "category">>) => void;
  deleteArtifact: (id: string) => void;
  mergeArtifacts: (keepId: string, mergeId: string) => void;
  addVote: (id: string) => boolean;
  removeVote: (id: string) => void;
  addComment: (id: string, body: string) => void;
  setActivityStatus: (id: string, status: ActivityStatus) => void;
}

const WorkshopContext = createContext<WorkshopContextValue | null>(null);

export function WorkshopProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<Role>("facilitator");
  const [workshop, setWorkshop] = useState<WorkshopRecord>(seedWorkshop);
  const [artifacts, setArtifacts] = useState<Artifact[]>(seedArtifacts);
  const [activities, setActivities] = useState<ActivityRow[]>(seedActivities);
  const [approvals, setApprovals] = useState<ApprovalItem[]>(seedApprovals);
  const [activityFeed, setActivityFeed] = useState<ActivityFeedItem[]>(seedActivityFeed);

  const pushActivity = useCallback((text: string, link?: ActivityLink) => {
    setActivityFeed((prev) => [
      { id: `act${Date.now()}`, actor: "You", text, time: "Just now", ...(link ? { link } : {}) },
      ...prev,
    ]);
  }, []);

  const updateWorkshop = useCallback(
    (patch: Partial<Pick<WorkshopRecord, "name" | "objective" | "tags">>) => {
      setWorkshop((prev) => ({ ...prev, ...patch }));
      pushActivity("updated the workshop details");
    },
    [pushActivity],
  );

  const setWorkshopStatus = useCallback(
    (status: WorkshopStatus) => {
      setWorkshop((prev) => ({ ...prev, status }));
      pushActivity(status === "Archived" ? "archived the workshop" : `moved the workshop to ${status}`);
    },
    [pushActivity],
  );

  const pendingApprovals = useMemo(
    () => approvals.filter((a) => a.decision === "pending").length,
    [approvals],
  );

  const decideApproval = useCallback<WorkshopContextValue["decideApproval"]>(
    (id, decision, note) => {
      let target: ApprovalItem | undefined;
      setApprovals((prev) =>
        prev.map((a) => {
          if (a.id !== id) return a;
          target = a;
          return { ...a, decision, note: note?.trim() || undefined, decidedBy: "You", decidedAt: "Just now" };
        }),
      );
      if (target) {
        const noun = target.type.replace(/s$/, "").toLowerCase();
        pushActivity(`${decision} ${noun} "${target.label}"`, { kind: "approval" });
      }
    },
    [pushActivity],
  );

  const resetApproval = useCallback((id: string) => {
    setApprovals((prev) =>
      prev.map((a) =>
        a.id === id
          ? { ...a, decision: "pending" as const, note: undefined, decidedBy: undefined, decidedAt: undefined }
          : a,
      ),
    );
  }, []);


  const votesUsed = useMemo(() => artifacts.reduce((sum, a) => sum + a.myVotes, 0), [artifacts]);
  const voteAllocation = workshop.votesPerParticipant;

  const addArtifact = useCallback<WorkshopContextValue["addArtifact"]>(
    (input) => {
      const id = `n${Date.now()}`;
      setArtifacts((prev) => [
        {
          id,
          category: input.category,
          title: input.title,
          description: input.description,
          tags: input.tags,
          author: "You",
          createdAt: "Today",
          votes: 0,
          myVotes: 0,
          comments: [],
        },
        ...prev,
      ]);
      pushActivity(`created artifact "${input.title}"`, {
        kind: "artifact",
        artifactId: id,
        category: input.category,
      });
    },
    [pushActivity],
  );

  const updateArtifact = useCallback<WorkshopContextValue["updateArtifact"]>(
    (id, patch) => {
      let target: Artifact | undefined;
      setArtifacts((prev) =>
        prev.map((a) => {
          if (a.id !== id) return a;
          target = { ...a, ...patch };
          return target;
        }),
      );
      if (target) {
        pushActivity(`updated artifact "${target.title}"`, {
          kind: "artifact",
          artifactId: target.id,
          category: target.category,
        });
      }
    },
    [pushActivity],
  );

  const deleteArtifact = useCallback(
    (id: string) => {
      let target: Artifact | undefined;
      setArtifacts((prev) => {
        target = prev.find((a) => a.id === id);
        return prev.filter((a) => a.id !== id);
      });
      if (target) {
        pushActivity(`deleted artifact "${target.title}"`);
      }
    },
    [pushActivity],
  );

  const mergeArtifacts = useCallback(
    (keepId: string, mergeId: string) => {
      let mergedItem: Artifact | undefined;
      let keptItem: Artifact | undefined;
      setArtifacts((prev) => {
        const merged = prev.find((a) => a.id === mergeId);
        if (!merged) return prev;
        mergedItem = merged;
        return prev
          .filter((a) => a.id !== mergeId)
          .map((a) => {
            if (a.id !== keepId) return a;
            keptItem = {
              ...a,
              votes: a.votes + merged.votes,
              myVotes: a.myVotes + merged.myVotes,
              tags: Array.from(new Set([...a.tags, ...merged.tags])),
              description: a.description,
            };
            return keptItem;
          });
      });
      if (mergedItem && keptItem) {
        pushActivity(`merged artifact "${mergedItem.title}" into "${keptItem.title}"`, {
          kind: "artifact",
          artifactId: keptItem.id,
          category: keptItem.category,
        });
      }
    },
    [pushActivity],
  );

  const addVote = useCallback(
    (id: string) => {
      let applied = false;
      setArtifacts((prev) => {
        const used = prev.reduce((sum, a) => sum + a.myVotes, 0);
        if (used >= voteAllocation) return prev;
        applied = true;
        return prev.map((a) => (a.id === id ? { ...a, votes: a.votes + 1, myVotes: a.myVotes + 1 } : a));
      });
      return applied;
    },
    [voteAllocation],
  );

  const removeVote = useCallback((id: string) => {
    setArtifacts((prev) =>
      prev.map((a) =>
        a.id === id && a.myVotes > 0 ? { ...a, votes: Math.max(0, a.votes - 1), myVotes: a.myVotes - 1 } : a,
      ),
    );
  }, []);

  const addComment = useCallback(
    (id: string, body: string) => {
      let target: Artifact | undefined;
      setArtifacts((prev) =>
        prev.map((a) => {
          if (a.id !== id) return a;
          target = a;
          return {
            ...a,
            comments: [...a.comments, { id: `c${Date.now()}`, author: "You", body, createdAt: "Just now" }],
          };
        }),
      );
      if (target) {
        pushActivity(`commented on artifact "${target.title}"`, {
          kind: "artifact",
          artifactId: target.id,
          category: target.category,
        });
      }
    },
    [pushActivity],
  );

  const setActivityStatus = useCallback(
    (id: string, status: ActivityStatus) => {
      let target: ActivityRow | undefined;
      setActivities((prev) =>
        prev.map((a) => {
          if (a.id !== id) return a;
          target = { ...a, status };
          return target;
        }),
      );
      if (target) {
        pushActivity(`marked activity "${target.name}" as ${status.replace(/-/g, " ")}`);
      }
    },
    [pushActivity],
  );

  const value = useMemo(
    () => ({
      role,
      setRole,
      currentUser: "You",
      workshop,
      updateWorkshop,
      setWorkshopStatus,
      artifacts,
      activities,
      approvals,
      activityFeed,
      pendingApprovals,
      decideApproval,
      resetApproval,
      votesUsed,
      votesRemaining: Math.max(0, voteAllocation - votesUsed),
      voteAllocation,
      addArtifact,
      updateArtifact,
      deleteArtifact,
      mergeArtifacts,
      addVote,
      removeVote,
      addComment,
      setActivityStatus,
    }),
    [
      role,
      workshop,
      updateWorkshop,
      setWorkshopStatus,
      artifacts,
      activities,
      approvals,
      activityFeed,
      pendingApprovals,
      decideApproval,
      resetApproval,
      votesUsed,
      voteAllocation,
      addArtifact,
      updateArtifact,
      deleteArtifact,
      mergeArtifacts,
      addVote,
      removeVote,
      addComment,
      setActivityStatus,
    ],
  );

  return <WorkshopContext.Provider value={value}>{children}</WorkshopContext.Provider>;
}

export function useWorkshop() {
  const ctx = useContext(WorkshopContext);
  if (!ctx) throw new Error("useWorkshop must be used inside WorkshopProvider");
  return ctx;
}

export function useCan(permission: string) {
  const { role } = useWorkshop();
  const map: Record<Role, string[]> = {
    participant: ["create-artifact", "vote", "comment", "ai"],
    analyst: ["create-artifact", "vote", "comment", "ai", "merge", "review-themes"],
    facilitator: [
      "create-artifact",
      "vote",
      "comment",
      "ai",
      "merge",
      "review-themes",
      "edit-workshop",
      "invite",
      "close-activity",
      "reclassify",
      "approve",
    ],
    executive: ["ai", "comment"],
  };
  return map[role].includes(permission);
}
