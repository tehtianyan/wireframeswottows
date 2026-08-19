import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  activities as seedActivities,
  approvalQueue as seedApprovals,
  seedArtifacts,
  workshop,
  type ActivityRow,
  type ActivityStatus,
  type ApprovalItem,
  type Artifact,
  type Role,
  type SwotCategory,
} from "./workshop-data";

interface WorkshopContextValue {
  role: Role;
  setRole: (r: Role) => void;
  currentUser: string;
  artifacts: Artifact[];
  activities: ActivityRow[];
  approvals: ApprovalItem[];
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
  const [artifacts, setArtifacts] = useState<Artifact[]>(seedArtifacts);
  const [activities, setActivities] = useState<ActivityRow[]>(seedActivities);
  const [approvals, setApprovals] = useState<ApprovalItem[]>(seedApprovals);

  const pendingApprovals = useMemo(
    () => approvals.filter((a) => a.decision === "pending").length,
    [approvals],
  );

  const decideApproval = useCallback<WorkshopContextValue["decideApproval"]>((id, decision, note) => {
    setApprovals((prev) =>
      prev.map((a) =>
        a.id === id
          ? { ...a, decision, note: note?.trim() || undefined, decidedBy: "You", decidedAt: "Just now" }
          : a,
      ),
    );
  }, []);

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

  const addArtifact = useCallback<WorkshopContextValue["addArtifact"]>((input) => {
    setArtifacts((prev) => [
      {
        id: `n${Date.now()}`,
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
  }, []);

  const updateArtifact = useCallback<WorkshopContextValue["updateArtifact"]>((id, patch) => {
    setArtifacts((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const deleteArtifact = useCallback((id: string) => {
    setArtifacts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const mergeArtifacts = useCallback((keepId: string, mergeId: string) => {
    setArtifacts((prev) => {
      const merged = prev.find((a) => a.id === mergeId);
      if (!merged) return prev;
      return prev
        .filter((a) => a.id !== mergeId)
        .map((a) =>
          a.id === keepId
            ? {
                ...a,
                votes: a.votes + merged.votes,
                myVotes: a.myVotes + merged.myVotes,
                tags: Array.from(new Set([...a.tags, ...merged.tags])),
                description: a.description,
              }
            : a,
        );
    });
  }, []);

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

  const addComment = useCallback((id: string, body: string) => {
    setArtifacts((prev) =>
      prev.map((a) =>
        a.id === id
          ? {
              ...a,
              comments: [
                ...a.comments,
                { id: `c${Date.now()}`, author: "You", body, createdAt: "Just now" },
              ],
            }
          : a,
      ),
    );
  }, []);

  const setActivityStatus = useCallback((id: string, status: ActivityStatus) => {
    setActivities((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
  }, []);

  const value = useMemo(
    () => ({
      role,
      setRole,
      currentUser: "You",
      artifacts,
      activities,
      approvals,
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
      artifacts,
      activities,
      approvals,
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
