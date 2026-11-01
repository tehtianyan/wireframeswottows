-- Organization branding — white labelling, stored as DATA on a table that
-- already exists.
--
-- WHY THESE COLUMNS AND NOT A TABLE: branding is three fields and nothing
-- references it by FK. The report-type decision set this precedent already
-- ("a configured section list, not a new table"); a `branding_settings`
-- key/value table would add a join and a vocabulary for no gain.
--
-- WHY A DATA URI AND NOT SUPABASE STORAGE: the report export promises a
-- self-contained archival file with no external requests, so it needs the
-- logo inline as a data URI regardless. Storing it in exactly that form
-- means one representation feeds all three consumers — the app header, the
-- branding endpoint and the Go report template — with no conversion step.
-- Storage would also have meant a bucket with its own RLS policies (created
-- outside supabase/migrations/, which is the convention gap that produced
-- both of this project's security findings) and a second client write path
-- around Go. For a ~20KB file per client that is a subsystem bought for
-- nothing. If the asset count or size ever grows past a logo, Storage
-- becomes the right answer and this column becomes the migration source.
--
-- The 256KB cap is enforced here as well as in Go, because a limit that
-- lives only in a handler is a limit the next writer does not know about.
-- At ~190KB of raw image that is far more than a header mark needs and far
-- less than a row that would make `select *` on organizations expensive.

alter table public.organizations
  add column if not exists display_name    text,
  add column if not exists logo_data_uri   text,
  add column if not exists logo_filename   text;

comment on column public.organizations.display_name is
  'White-label product name. Null means fall back to organizations.name.';
comment on column public.organizations.logo_data_uri is
  'base64 data URI of the client logo. Null means fall back to the initials mark. PNG/JPEG only — SVG is refused on upload because it can carry script.';
comment on column public.organizations.logo_filename is
  'Original filename, shown in the admin panel so an administrator can tell what is loaded.';

-- Belt and braces on the two things Go also checks. A CHECK cannot decode an
-- image, but it CAN keep the column from holding something that is obviously
-- not one, and it cannot be bypassed by a future handler that forgets.
alter table public.organizations
  drop constraint if exists organizations_logo_data_uri_check;

alter table public.organizations
  add constraint organizations_logo_data_uri_check check (
    logo_data_uri is null
    or (
      length(logo_data_uri) <= 262144
      and logo_data_uri ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$'
    )
  );

-- A display name of '' would render as an empty header rather than falling
-- back, which is the kind of "configured to nothing" state that reads as a
-- bug. Null is the only way to say "use the default".
alter table public.organizations
  drop constraint if exists organizations_display_name_check;

alter table public.organizations
  add constraint organizations_display_name_check check (
    display_name is null or length(btrim(display_name)) > 0
  );
