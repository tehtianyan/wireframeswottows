export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string
          first_name: string | null
          last_name: string | null
          display_name: string | null
          global_role: string
          status: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          email: string
          first_name?: string | null
          last_name?: string | null
          display_name?: string | null
          global_role?: string
          status?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          email?: string
          first_name?: string | null
          last_name?: string | null
          display_name?: string | null
          global_role?: string
          status?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      workshops: {
        Row: {
          id: string
          workspace_id: string
          name: string
          description: string | null
          objective: string | null
          facilitator_id: string | null
          status: string
          start_date: string | null
          end_date: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          workspace_id: string
          name: string
          description?: string | null
          objective?: string | null
          facilitator_id?: string | null
          status?: string
          start_date?: string | null
          end_date?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          workspace_id?: string
          name?: string
          description?: string | null
          objective?: string | null
          facilitator_id?: string | null
          status?: string
          start_date?: string | null
          end_date?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      workshop_members: {
        Row: {
          id: string
          workshop_id: string
          user_id: string
          role: string
          invited_at: string | null
          joined_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          workshop_id: string
          user_id: string
          role?: string
          invited_at?: string | null
          joined_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          workshop_id?: string
          user_id?: string
          role?: string
          invited_at?: string | null
          joined_at?: string | null
          created_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      workshop_roster: {
        Row: {
          workshop_id: string
          id: string
          email: string
          name: string
          role: string
          joined_at: string | null
          invited_at: string | null
          status: string
          votes_used: number
          artifacts_count: number
          comments_count: number
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
