-- The app sends its own invitation mail, with editable copy and a delivery log.
--
-- WHY NOT GOTRUE'S TEMPLATES. Supabase can mail an invitation, and its
-- templates can be edited — in the Supabase DASHBOARD, per project, by
-- somebody with dashboard access. Three things follow that no amount of
-- template editing fixes:
--
--   1. A GoTrue template can only interpolate what GoTrue knows: the address,
--      the link, the token, the Site URL and the user's own metadata. It does
--      NOT know who did the inviting or which workshop they were invited to,
--      and those are precisely the two facts that make an invitation read as
--      an invitation. Without them the best available subject is "Reset Your
--      Password" — which is what real invitees received, and which reads as
--      phishing because an unsolicited password-reset mail IS the commonest
--      phishing pattern there is.
--   2. "Customizable from the Administration page" is unsatisfiable while the
--      copy lives in a vendor dashboard. The admin page cannot edit it, and
--      nothing in this repo can assert what it says.
--   3. Stuffing the inviter and workshop into user_metadata to reach
--      `{{ .Data }}` would make per-invitation facts into per-ACCOUNT state —
--      wrong the moment somebody is invited to a second workshop, and a
--      mutation of an identity record in order to render a string.
--
-- So the copy is DATA here and the send is ours (pkg/mailer, stdlib SMTP, no
-- new dependency and no provider lock-in). GoTrue still mints the one-time
-- token; it just no longer writes the words.
--
-- WHY PLATFORM-WIDE AND NOT PER-ORGANIZATION. The per-client axis already
-- exists and is BRANDING: name and logo on `organizations`, which these
-- templates interpolate. The words themselves are the product's voice, the
-- same for every client, and /admin is a platform surface. One row per
-- template is therefore one place to edit; a per-organization override would
-- be eight copies of the same paragraph drifting apart, and the first client
-- whose copy was never customised would get the default anyway. If a client
-- ever genuinely needs different words, this table grows a nullable
-- organization_id and the resolver overlays it — the same shape branding
-- already uses.

create table if not exists public.email_templates (
  -- The template's role, not a display name. Go names these as constants; a
  -- CHECK keeps a typo from creating a row nothing will ever send.
  key           text primary key,
  subject       text        not null,
  -- The body is PLAIN TEXT with {{placeholders}}, and that is deliberate.
  -- An admin editing marketing-grade HTML in a textarea produces broken
  -- HTML, and an invitation is a short personal message rather than a
  -- newsletter. pkg/mailer renders this to a text part and a simple HTML
  -- part from the same source, so the two can never disagree.
  body          text        not null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid        references public.profiles (id) on delete set null,

  constraint email_templates_key_check check (
    key in ('participant_invite', 'password_reset', 'password_set_confirmation')
  ),
  -- Empty copy is a configured-to-nothing state that reads as a bug: the
  -- invitation goes out with no subject and no words. Resetting to the
  -- default is a separate action, not an empty save.
  constraint email_templates_subject_check check (length(btrim(subject)) > 0),
  constraint email_templates_body_check check (length(btrim(body)) > 0)
);

-- Every attempt, with its outcome. THIS IS THE DELIVERABILITY FIX that is
-- actually ours to make: "the yahoo.com address never received it" was
-- unanswerable, because nothing recorded whether a send was attempted, what
-- the mail server said, or which route the invitation took. An audit row said
-- `delivery: emailed`, which recorded our INTENT rather than the provider's
-- answer. A 550, a greylist deferral and a silent accept-then-drop all looked
-- identical from the admin page.
--
-- It stores the provider's own words and NOT the link: until used, that token
-- is a bearer credential for the account, and the same reasoning that keeps it
-- out of audit_events keeps it out of here.
create table if not exists public.email_deliveries (
  id            uuid primary key default gen_random_uuid(),
  to_email      text        not null,
  template_key  text        not null,
  subject       text        not null,
  -- 'sent' means the SMTP server ACCEPTED it, which is the strongest claim
  -- any sender can make — it is not proof of inbox placement, and the admin
  -- panel says so rather than implying delivery.
  status        text        not null,
  -- The server's verbatim reply on failure. Quoted, never paraphrased: the
  -- first version of explainMailFailure guessed a cause and named the wrong
  -- one with full confidence.
  error         text,
  -- 'smtp' when we sent it, 'supabase' when we fell back to GoTrue's mailer,
  -- 'link' when no mail was possible and a link was handed over instead.
  route         text        not null,
  actor_id      uuid        references public.profiles (id) on delete set null,
  workshop_id   uuid        references public.workshops (id) on delete set null,
  created_at    timestamptz not null default now(),

  constraint email_deliveries_status_check check (status in ('sent', 'failed', 'skipped')),
  constraint email_deliveries_route_check check (route in ('smtp', 'supabase', 'link')),
  -- A failure with no reason is the thing this table exists to stop. Saying
  -- "it failed" and nothing else is where the yahoo.com question started.
  constraint email_deliveries_error_check check (
    status <> 'failed' or length(btrim(coalesce(error, ''))) > 0
  )
);

create index if not exists email_deliveries_created_idx
  on public.email_deliveries (created_at desc);
create index if not exists email_deliveries_email_idx
  on public.email_deliveries (lower(to_email), created_at desc);

-- RLS ON, NO POLICIES. Both tables are Go-only: the copy is written from
-- /admin through a platform-admin check, and the log is read there too. Go
-- connects as `postgres` (rolbypassrls) so zero policies costs it nothing and
-- denies every browser client — which is what we want for a table holding
-- every invited address. Enabling it also keeps public.rls_coverage_gaps
-- empty; see the assertion at the end of this file.
alter table public.email_templates   enable row level security;
alter table public.email_deliveries  enable row level security;

revoke all on public.email_templates  from anon, authenticated;
revoke all on public.email_deliveries from anon, authenticated;

-- The default copy.
--
-- `on conflict do update` is WRONG here and the distinction matters: these
-- rows are not configuration seeded from the repo like the AI prompts, they
-- are content an administrator is expected to edit. Re-running the migration
-- must not quietly overwrite what they wrote. `do nothing` means the defaults
-- are a starting point rather than a recurring reset.
--
-- Three things every invitation says, and the reason it says them:
--   * WHO invited you, by name, with their email — an invitation from nobody
--     is indistinguishable from a phishing attempt, and the recipient's first
--     question is "do I know this person?".
--   * WHICH workshop, and what their role in it is — so the mail is about a
--     thing they recognise rather than about their password.
--   * What the link does and that it expires — a one-time link that is not
--     explained reads as a credential-harvesting link.
-- The word "password" appears, because they do have to choose one; it is just
-- no longer the SUBJECT of the message.
-- THREE WORDINGS CAME FROM READING A REAL ONE (tests/peek-invite.mjs), not
-- from a failing check — every property held while the sentences were wrong:
--
--   * "invited you to the {{workshop_name}} workshop" rendered as "...to the
--     Digital Transformation Strategy Workshop workshop". Workshop names
--     already contain the word, so the wrapper stutters.
--   * "take part in a strategy workshop on {{product_name}}" read as "...on
--     Kermit - Fozzie - Gonzo". The product name is the platform, not the
--     subject of the workshop, and no sentence should put it there. It belongs
--     in the sign-off, where it already was.
--   * "it expires in 24 hours" states a number THIS CODE CANNOT SEE — the
--     expiry is a GoTrue setting, so a dashboard change would silently make
--     the sentence a lie. The same reasoning as RedirectWarning: do not assert
--     what another system decides.
insert into public.email_templates (key, subject, body) values
('participant_invite',
 '{{inviter_name}} has invited you to {{workshop_name}}',
 'Hello {{recipient_name}},

{{inviter_name}} ({{inviter_email}}) has invited you to take part in a strategy workshop.

  Workshop:   {{workshop_name}}
  Your role:  {{role}}
  Invited by: {{inviter_name}} <{{inviter_email}}>

{{objective_line}}
To accept, open the link below and choose a password. It is unique to you and
it can only be used once, so open it soon — and open it yourself rather than
forwarding it on.

{{action_url}}

If you were not expecting this, you can safely ignore this message — no
account is active until you choose a password. Any questions, just reply to
this message and it will reach {{inviter_name}}, who sent the invitation.

{{product_name}}'),

('password_reset',
 'Reset your {{product_name}} password',
 'Hello {{recipient_name}},

Somebody asked to reset the password for the {{product_name}} account
registered to {{recipient_email}}.

If that was you, open the link below to choose a new one. It can only be used
once, so open it soon.

{{action_url}}

If it was not you, ignore this message — your password has not been changed
and nobody can use this link but you.

{{product_name}}'),

-- Item 5: the reassurance. Setting a password is the moment somebody becomes a
-- participant, and until now nothing confirmed it — they were left wondering
-- whether the one-time link had worked. It also gives them a plain sign-in URL
-- to keep, which the one-time link deliberately is not.
('password_set_confirmation',
 'You are all set — welcome to {{product_name}}',
 'Hello {{recipient_name}},

Your password is set and your account is ready. You are now a participant on:

{{workshop_list}}
Sign in any time at:

{{site_url}}

Use your email address ({{recipient_email}}) and the password you just chose.
You will not need the invitation link again.

If you did not just set a password, tell us straight away by replying to this
message — somebody else may have used your invitation link.

{{product_name}}')
on conflict (key) do nothing;

-- The convention this project learned the hard way: a table created outside
-- the migration system skips the conventions migrations apply, and RLS was the
-- one that bit twice. Assert rather than trust the two ALTERs above.
do $$
declare gaps text;
begin
  select string_agg(table_name, ', ') into gaps from public.rls_coverage_gaps;
  if gaps is not null then
    raise exception 'RLS coverage gaps after this migration: %', gaps;
  end if;
end $$;

-- And assert the seed actually landed, rather than trusting an INSERT whose
-- conflict clause is do-nothing: if a previous partial run left one row
-- behind, the other two would be silently missing and the first invitation
-- would fail at send time.
do $$
declare n int;
begin
  select count(*) into n from public.email_templates;
  if n <> 3 then
    raise exception 'expected 3 email templates, found %', n;
  end if;
end $$;
