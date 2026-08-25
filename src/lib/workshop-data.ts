export type SwotCategory = "strength" | "weakness" | "opportunity" | "threat";

export type ActivityStatus = "not-started" | "in-progress" | "complete" | "blocked";

export type WorkshopStage =
  | "strengths"
  | "weaknesses"
  | "opportunities"
  | "threats"
  | "prioritization"
  | "themes"
  | "tows"
  | "insights"
  | "recommendations"
  | "reporting";

export type Role = "participant" | "analyst" | "facilitator" | "executive";

export interface Artifact {
  id: string;
  category: SwotCategory;
  title: string;
  description: string;
  tags: string[];
  author: string;
  createdAt: string;
  votes: number;
  myVotes: number;
  comments: Comment[];
  aiGenerated?: boolean;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ActivityRow {
  id: string;
  stage: WorkshopStage;
  name: string;
  status: ActivityStatus;
  owner: string;
  dueDate: string;
}

export interface Participant {
  id: string;
  name: string;
  role: Role;
  presence: "online" | "idle" | "offline";
}

export const lifecycleStates = [
  "Draft",
  "Configured",
  "Active",
  "Analysis",
  "Reporting",
  "Completed",
  "Archived",
] as const;

export type WorkshopStatus = (typeof lifecycleStates)[number];

export interface WorkshopRecord {
  id: string;
  name: string;
  status: WorkshopStatus;
  objective: string;
  facilitator: string;
  createdAt: string;
  tags: string[];
  votesPerParticipant: number;
}

export const workshop: WorkshopRecord = {
  id: "ws-003",
  name: "Digital Transformation Strategy Workshop",
  status: "Active",
  objective: "Identify strategic priorities for the next three years.",
  facilitator: "Jane Smith",
  createdAt: "02 Jun 2026",
  tags: ["Digital", "Three-Year Horizon", "Executive Sponsored"],
  votesPerParticipant: 20,
};

export const activities: ActivityRow[] = [
  { id: "a1", stage: "strengths", name: "Strength Discovery", status: "complete", owner: "Jane", dueDate: "15 Jun" },
  { id: "a2", stage: "weaknesses", name: "Weakness Discovery", status: "complete", owner: "Jane", dueDate: "15 Jun" },
  { id: "a3", stage: "opportunities", name: "Opportunity Discovery", status: "complete", owner: "Alex", dueDate: "17 Jun" },
  { id: "a4", stage: "threats", name: "Threat Discovery", status: "in-progress", owner: "Alex", dueDate: "19 Jun" },
  { id: "a5", stage: "prioritization", name: "Prioritization", status: "in-progress", owner: "Sarah", dueDate: "20 Jun" },
  { id: "a6", stage: "themes", name: "Theme Analysis", status: "in-progress", owner: "Alex", dueDate: "20 Jun" },
  { id: "a7", stage: "tows", name: "TOWS Matrix", status: "not-started", owner: "Jane", dueDate: "24 Jun" },
  { id: "a8", stage: "insights", name: "Insight Generation", status: "not-started", owner: "Priya", dueDate: "26 Jun" },
  { id: "a9", stage: "recommendations", name: "Recommendations", status: "blocked", owner: "Priya", dueDate: "28 Jun" },
  { id: "a10", stage: "reporting", name: "Reporting", status: "not-started", owner: "Jane", dueDate: "30 Jun" },
];

export const stageLabels: Record<WorkshopStage, string> = {
  strengths: "Strengths",
  weaknesses: "Weaknesses",
  opportunities: "Opportunities",
  threats: "Threats",
  prioritization: "Prioritization",
  themes: "Themes",
  tows: "TOWS",
  insights: "Insights",
  recommendations: "Recommendations",
  reporting: "Reporting",
};

export const categoryMeta: Record<
  SwotCategory,
  { label: string; activity: string; guidance: string; color: string; slug: string }
> = {
  strength: {
    label: "Strength",
    activity: "Strength Discovery",
    slug: "strengths",
    guidance:
      "Identify capabilities, assets, relationships, skills, technologies, intellectual property, brand advantages, and organizational strengths.",
    color: "text-strength",
  },
  weakness: {
    label: "Weakness",
    activity: "Weakness Discovery",
    slug: "weaknesses",
    guidance:
      "Identify capability gaps, process inefficiencies, legacy constraints, skill shortages, and structural limitations that reduce performance.",
    color: "text-weakness",
  },
  opportunity: {
    label: "Opportunity",
    activity: "Opportunity Discovery",
    slug: "opportunities",
    guidance:
      "Identify market opportunities, customer needs, technology shifts, regulatory changes, or emerging trends.",
    color: "text-opportunity",
  },
  threat: {
    label: "Threat",
    activity: "Threat Discovery",
    slug: "threats",
    guidance:
      "Identify competitive pressure, disruptive entrants, regulatory risk, supply constraints, and shifts that could erode current position.",
    color: "text-threat",
  },
};

export const slugToCategory: Record<string, SwotCategory> = {
  strengths: "strength",
  weaknesses: "weakness",
  opportunities: "opportunity",
  threats: "threat",
};

export const participants: Participant[] = [
  { id: "p1", name: "Jane Smith", role: "facilitator", presence: "online" },
  { id: "p2", name: "Sarah Chen", role: "analyst", presence: "online" },
  { id: "p3", name: "John Okafor", role: "participant", presence: "online" },
  { id: "p4", name: "Alex Meyer", role: "analyst", presence: "idle" },
  { id: "p5", name: "Priya Nair", role: "participant", presence: "online" },
  { id: "p6", name: "Tom Rivera", role: "participant", presence: "idle" },
  { id: "p7", name: "Ingrid Holm", role: "executive", presence: "offline" },
  { id: "p8", name: "Marcus Lee", role: "participant", presence: "offline" },
  { id: "p9", name: "Dana Whitfield", role: "participant", presence: "online" },
  { id: "p10", name: "Omar Haddad", role: "participant", presence: "offline" },
  { id: "p11", name: "Lena Fischer", role: "participant", presence: "online" },
  { id: "p12", name: "Ravi Menon", role: "executive", presence: "offline" },
];

function artifact(
  id: string,
  category: SwotCategory,
  title: string,
  description: string,
  tags: string[],
  author: string,
  votes: number,
  createdAt = "12 Jun",
  aiGenerated = false,
): Artifact {
  return {
    id,
    category,
    title,
    description,
    tags,
    author,
    createdAt,
    votes,
    myVotes: 0,
    comments: [],
    aiGenerated,
  };
}

export const seedArtifacts: Artifact[] = [
  artifact("s1", "strength", "Strong Customer Loyalty", "Net retention above 118% across enterprise accounts for eight consecutive quarters.", ["Customers", "Retention"], "John Okafor", 28, "10 Jun"),
  artifact("s2", "strength", "High Customer Retention", "Churn in the mid-market segment remains under 4% annually.", ["Customers"], "Sarah Chen", 11, "10 Jun"),
  artifact("s3", "strength", "Proprietary Data Assets", "Fifteen years of curated operational benchmarking data no competitor can replicate.", ["Data", "Moat"], "Alex Meyer", 22, "11 Jun"),
  artifact("s4", "strength", "Experienced Delivery Teams", "Average tenure of nine years in the professional services organisation.", ["People"], "Priya Nair", 14, "11 Jun"),
  artifact("s5", "strength", "Regulatory Credibility", "Accredited in four regulated markets, shortening enterprise procurement cycles.", ["Compliance"], "Jane Smith", 17, "12 Jun"),
  artifact("s6", "strength", "Partner Ecosystem Reach", "Fifty-two active implementation partners covering three regions.", ["Partners"], "Dana Whitfield", 9, "12 Jun", true),

  artifact("w1", "weakness", "Legacy Technology Stack", "Core platform still runs on a monolith with a 14-day release cycle.", ["Technology", "Debt"], "Alex Meyer", 24, "10 Jun"),
  artifact("w2", "weakness", "Fragmented Customer Data", "Customer records are duplicated across CRM, billing, and support systems.", ["Data"], "Sarah Chen", 19, "10 Jun"),
  artifact("w3", "weakness", "Slow Hiring Pipeline", "Average time-to-hire for engineering roles is 94 days.", ["People"], "Priya Nair", 12, "11 Jun"),
  artifact("w4", "weakness", "Limited Self-Service", "Eighty percent of onboarding requires manual professional services effort.", ["Product", "Cost"], "John Okafor", 16, "11 Jun"),
  artifact("w5", "weakness", "Thin Analytics Capability", "No unified reporting layer, so executives rely on manual spreadsheets.", ["Data", "Analytics"], "Lena Fischer", 13, "12 Jun"),

  artifact("o1", "opportunity", "AI-Assisted Advisory Services", "Package existing benchmarking data into an AI advisory tier for mid-market clients.", ["AI", "Growth"], "Sarah Chen", 26, "11 Jun"),
  artifact("o2", "opportunity", "Regulatory Reporting Mandate", "New 2027 disclosure rules create demand for automated compliance reporting.", ["Regulation"], "Jane Smith", 21, "11 Jun"),
  artifact("o3", "opportunity", "Southeast Asia Expansion", "Partner-led entry into three high-growth markets with low incumbent density.", ["Geography", "Growth"], "Ravi Menon", 18, "12 Jun"),
  artifact("o4", "opportunity", "Marketplace Distribution", "Cloud marketplaces could shorten procurement from months to days.", ["Channel"], "Dana Whitfield", 10, "12 Jun", true),
  artifact("o5", "opportunity", "Usage-Based Pricing", "Consumption pricing could unlock smaller accounts currently priced out.", ["Pricing"], "Marcus Lee", 8, "12 Jun"),

  artifact("t1", "threat", "Well-Funded AI Entrants", "Three venture-backed entrants launched adjacent products in the last year.", ["Competition", "AI"], "Alex Meyer", 23, "11 Jun"),
  artifact("t2", "threat", "Talent Poaching", "Competitors offering 25% premiums for platform engineers.", ["People"], "Priya Nair", 15, "12 Jun"),
  artifact("t3", "threat", "Data Sovereignty Rules", "Emerging localisation requirements may force costly regional hosting.", ["Regulation", "Cost"], "Jane Smith", 17, "12 Jun"),
  artifact("t4", "threat", "Platform Vendor Dependency", "Two critical capabilities depend on a single infrastructure vendor.", ["Risk"], "Lena Fischer", 12, "12 Jun"),
];

export const themes = [
  { id: "th1", name: "Digital Enablement", artifactCount: 14, confidence: 92 },
  { id: "th2", name: "Data as a Strategic Asset", artifactCount: 11, confidence: 88 },
  { id: "th3", name: "Operating Model Modernisation", artifactCount: 9, confidence: 81 },
  { id: "th4", name: "Talent Resilience", artifactCount: 7, confidence: 74 },
];

export const insights = [
  {
    id: "in1",
    title: "Data moat is under-monetised",
    significance: "High",
    supportingThemes: ["Data as a Strategic Asset", "Digital Enablement"],
  },
  {
    id: "in2",
    title: "Delivery cost structure blocks mid-market growth",
    significance: "High",
    supportingThemes: ["Operating Model Modernisation"],
  },
  {
    id: "in3",
    title: "Regulatory credibility is a defensible wedge",
    significance: "Medium",
    supportingThemes: ["Digital Enablement"],
  },
];

export const recommendations = [
  { id: "r1", text: "Launch an AI advisory tier built on proprietary benchmark data", priority: "Critical", insightCount: 3 },
  { id: "r2", text: "Decompose the monolith along customer lifecycle boundaries", priority: "High", insightCount: 2 },
  { id: "r3", text: "Stand up a unified customer data platform within two quarters", priority: "High", insightCount: 2 },
  { id: "r4", text: "Enter Southeast Asia through accredited implementation partners", priority: "Medium", insightCount: 1 },
];

export const emergingRisks = [
  "Threat discovery is still open while prioritisation has started",
  "Recommendation drafting is blocked pending insight approval",
  "Two executive reviewers have not accessed the workshop this week",
];

export type ActivityLink =
  | { kind: "artifact"; artifactId: string; category: SwotCategory }
  | { kind: "category"; category: SwotCategory }
  | { kind: "approval" };

export interface ActivityFeedItem {
  id: string;
  actor: string;
  text: string;
  time: string;
  link?: ActivityLink;
}

export const activityFeed: ActivityFeedItem[] = [
  {
    id: "f1",
    actor: "John",
    text: 'created artifact "Strong Customer Loyalty"',
    time: "8 min ago",
    link: { kind: "artifact", artifactId: "s1", category: "strength" },
  },
  { id: "f2", actor: "AI Assistant", text: "generated 6 themes from 86 artifacts", time: "42 min ago" },
  {
    id: "f3",
    actor: "Sarah",
    text: 'approved theme "Data as a Strategic Asset"',
    time: "2 hours ago",
    link: { kind: "approval" },
  },
  { id: "f4", actor: "System", text: "published report Executive Summary v1.0", time: "Yesterday" },
  {
    id: "f5",
    actor: "Alex",
    text: "merged 2 duplicate artifacts in Opportunity Discovery",
    time: "Yesterday",
    link: { kind: "category", category: "opportunity" },
  },
];

export type ApprovalType = "Themes" | "Insights" | "Recommendations";
export type ApprovalDecision = "pending" | "approved" | "rejected";

export interface ApprovalItem {
  id: string;
  type: ApprovalType;
  label: string;
  count: number;
  summary: string;
  submittedBy: string;
  submittedAt: string;
  evidence: string[];
  decision: ApprovalDecision;
  decidedBy?: string | undefined;
  decidedAt?: string | undefined;
  note?: string | undefined;
}

export const approvalQueue: ApprovalItem[] = [
  {
    id: "q1",
    type: "Themes",
    label: "Talent Resilience",
    count: 2,
    summary: "Cluster of 7 artifacts on hiring speed, attrition risk and competitor pay premiums.",
    submittedBy: "AI Assistant",
    submittedAt: "42 min ago",
    evidence: ["Slow Hiring Pipeline", "Talent Poaching", "Deep Domain Expertise"],
    decision: "pending",
  },
  {
    id: "q2",
    type: "Insights",
    label: "Regulatory credibility is a defensible wedge",
    count: 1,
    summary: "Medium-significance insight linking compliance track record to the 2027 disclosure mandate.",
    submittedBy: "Lena Fischer",
    submittedAt: "2 hours ago",
    evidence: ["Regulatory Reporting Mandate", "Data Sovereignty Rules"],
    decision: "pending",
  },
  {
    id: "q3",
    type: "Recommendations",
    label: "Usage-based pricing pilot",
    count: 3,
    summary: "Proposal to pilot consumption pricing in two segments before a full rollout decision.",
    submittedBy: "Marcus Lee",
    submittedAt: "Yesterday",
    evidence: ["Usage-Based Pricing", "Limited Self-Service", "Marketplace Distribution"],
    decision: "pending",
  },
  {
    id: "q4",
    type: "Themes",
    label: "Data as a Strategic Asset",
    count: 4,
    summary: "Eleven artifacts describing under-used proprietary benchmarking data.",
    submittedBy: "AI Assistant",
    submittedAt: "Yesterday",
    evidence: ["Proprietary Benchmark Data", "Thin Analytics Capability"],
    decision: "approved",
    decidedBy: "Sarah Chen",
    decidedAt: "2 hours ago",
  },
];


export const rolePermissions: Record<Role, string[]> = {
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

export const roleLabels: Record<Role, string> = {
  participant: "Participant",
  analyst: "Analyst",
  facilitator: "Facilitator",
  executive: "Executive",
};
