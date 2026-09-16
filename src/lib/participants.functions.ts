import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

interface InviteInput {
  workshopId: string;
  name: string;
  email: string;
  role: "facilitator" | "participant" | "executive_viewer" | "analyst" | "observer";
}

// Creating a login-capable account requires the Admin API (service role), which
// must never reach the browser bundle — hence a server function rather than a
// direct client call. The demo has no real email delivery, so new accounts get
// the same shared demo password as the seeded roster.
const DEMO_PASSWORD = "SwotDemo2026!";

export const inviteParticipantFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: InviteInput) => d)
  .handler(async ({ data, context }) => {
    const { data: membership } = await context.supabase
      .from("workshop_members")
      .select("role")
      .eq("workshop_id", data.workshopId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!membership || membership.role !== "facilitator") {
      throw new Error("Only a facilitator can invite participants");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [firstName, ...rest] = data.name.trim().split(" ");
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: rest.join(" "), display_name: data.name },
    });
    if (error) throw new Error(error.message);

    const { error: memberError } = await supabaseAdmin.from("workshop_members").insert({
      workshop_id: data.workshopId,
      user_id: created.user.id,
      role: data.role,
      invited_at: new Date().toISOString(),
    });
    if (memberError) throw new Error(memberError.message);

    return { id: created.user.id };
  });
