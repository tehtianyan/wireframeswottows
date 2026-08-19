CREATE TABLE public.workshop_participants (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'participant',
  presence text NOT NULL DEFAULT 'offline',
  status text NOT NULL DEFAULT 'active',
  votes_used integer NOT NULL DEFAULT 0,
  artifacts_count integer NOT NULL DEFAULT 0,
  comments_count integer NOT NULL DEFAULT 0,
  joined_at date NOT NULL DEFAULT now(),
  last_active text NOT NULL DEFAULT 'never',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workshop_participants TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workshop_participants TO authenticated;
GRANT ALL ON public.workshop_participants TO service_role;

ALTER TABLE public.workshop_participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Prototype roster is readable by everyone"
  ON public.workshop_participants FOR SELECT USING (true);
CREATE POLICY "Prototype roster is insertable by everyone"
  ON public.workshop_participants FOR INSERT WITH CHECK (true);
CREATE POLICY "Prototype roster is updatable by everyone"
  ON public.workshop_participants FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Prototype roster is deletable by everyone"
  ON public.workshop_participants FOR DELETE USING (true);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$
LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER workshop_participants_updated_at
  BEFORE UPDATE ON public.workshop_participants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.workshop_participants (name, email, role, presence, status, votes_used, artifacts_count, comments_count, joined_at, last_active) VALUES
  ('Jane Smith','jane.smith@example.com','facilitator','online','active',18,6,14,'2026-06-02','2 min ago'),
  ('Sarah Chen','sarah.chen@example.com','analyst','online','active',20,5,11,'2026-06-02','5 min ago'),
  ('John Okafor','john.okafor@example.com','participant','online','active',16,4,7,'2026-06-03','12 min ago'),
  ('Alex Meyer','alex.meyer@example.com','analyst','idle','active',14,5,9,'2026-06-03','48 min ago'),
  ('Priya Nair','priya.nair@example.com','participant','online','active',19,4,6,'2026-06-04','9 min ago'),
  ('Tom Rivera','tom.rivera@example.com','participant','idle','active',8,1,2,'2026-06-05','1 hour ago'),
  ('Ingrid Holm','ingrid.holm@example.com','executive','offline','active',0,0,1,'2026-06-05','3 days ago'),
  ('Marcus Lee','marcus.lee@example.com','participant','offline','active',6,1,0,'2026-06-06','2 days ago'),
  ('Dana Whitfield','dana.whitfield@example.com','participant','online','active',12,2,4,'2026-06-06','21 min ago'),
  ('Omar Haddad','omar.haddad@example.com','participant','offline','invited',0,0,0,'2026-06-08','never'),
  ('Lena Fischer','lena.fischer@example.com','participant','online','active',15,2,5,'2026-06-08','7 min ago'),
  ('Ravi Menon','ravi.menon@example.com','executive','offline','active',4,1,1,'2026-06-09','4 days ago');