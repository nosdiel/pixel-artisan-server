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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      api_keys: {
        Row: {
          created_at: string
          id: string
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      images: {
        Row: {
          created_at: string
          height: number
          id: string
          optimized_size_bytes: number
          original_path: string | null
          original_size_bytes: number
          preset: string | null
          slug: string
          source: string
          template_id: string | null
          title: string
          updated_at: string
          user_id: string
          variants: Json
          width: number
        }
        Insert: {
          created_at?: string
          height?: number
          id?: string
          optimized_size_bytes?: number
          original_path?: string | null
          original_size_bytes?: number
          preset?: string | null
          slug: string
          source?: string
          template_id?: string | null
          title?: string
          updated_at?: string
          user_id: string
          variants?: Json
          width?: number
        }
        Update: {
          created_at?: string
          height?: number
          id?: string
          optimized_size_bytes?: number
          original_path?: string | null
          original_size_bytes?: number
          preset?: string | null
          slug?: string
          source?: string
          template_id?: string | null
          title?: string
          updated_at?: string
          user_id?: string
          variants?: Json
          width?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      square_connections: {
        Row: {
          access_token: string | null
          auto_sync_enabled: boolean
          client_id: string | null
          client_secret: string | null
          created_at: string
          environment: string
          last_sync_at: string | null
          location_id: string | null
          merchant_id: string | null
          restaurant_guid: string | null
          site_url: string | null
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token?: string | null
          auto_sync_enabled?: boolean
          client_id?: string | null
          client_secret?: string | null
          created_at?: string
          environment?: string
          last_sync_at?: string | null
          location_id?: string | null
          merchant_id?: string | null
          restaurant_guid?: string | null
          site_url?: string | null
          source?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string | null
          auto_sync_enabled?: boolean
          client_id?: string | null
          client_secret?: string | null
          created_at?: string
          environment?: string
          last_sync_at?: string | null
          location_id?: string | null
          merchant_id?: string | null
          restaurant_guid?: string | null
          site_url?: string | null
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      square_items_cache: {
        Row: {
          category: string | null
          currency: string | null
          description: string | null
          id: string
          name: string | null
          price_cents: number | null
          raw: Json | null
          square_item_id: string
          synced_at: string
          user_id: string
        }
        Insert: {
          category?: string | null
          currency?: string | null
          description?: string | null
          id?: string
          name?: string | null
          price_cents?: number | null
          raw?: Json | null
          square_item_id: string
          synced_at?: string
          user_id: string
        }
        Update: {
          category?: string | null
          currency?: string | null
          description?: string | null
          id?: string
          name?: string | null
          price_cents?: number | null
          raw?: Json | null
          square_item_id?: string
          synced_at?: string
          user_id?: string
        }
        Relationships: []
      }
      square_sync_jobs: {
        Row: {
          cursor: string | null
          error: string | null
          finished_at: string | null
          id: string
          processed_items: number
          stale_templates: number
          started_at: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cursor?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          processed_items?: number
          stale_templates?: number
          started_at?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cursor?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          processed_items?: number
          stale_templates?: number
          started_at?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      template_renders: {
        Row: {
          id: string
          image_id: string | null
          price_snapshot: Json | null
          rendered_at: string
          template_id: string
          user_id: string
        }
        Insert: {
          id?: string
          image_id?: string | null
          price_snapshot?: Json | null
          rendered_at?: string
          template_id: string
          user_id: string
        }
        Update: {
          id?: string
          image_id?: string | null
          price_snapshot?: Json | null
          rendered_at?: string
          template_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "template_renders_image_id_fkey"
            columns: ["image_id"]
            isOneToOne: false
            referencedRelation: "images"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_renders_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "templates"
            referencedColumns: ["id"]
          },
        ]
      }
      templates: {
        Row: {
          canvas_json: Json
          created_at: string
          height: number
          id: string
          is_stale: boolean
          last_price_snapshot: Json | null
          name: string
          preset: string
          square_bindings: Json
          thumbnail_path: string | null
          updated_at: string
          user_id: string
          width: number
        }
        Insert: {
          canvas_json?: Json
          created_at?: string
          height?: number
          id?: string
          is_stale?: boolean
          last_price_snapshot?: Json | null
          name?: string
          preset?: string
          square_bindings?: Json
          thumbnail_path?: string | null
          updated_at?: string
          user_id: string
          width?: number
        }
        Update: {
          canvas_json?: Json
          created_at?: string
          height?: number
          id?: string
          is_stale?: boolean
          last_price_snapshot?: Json | null
          name?: string
          preset?: string
          square_bindings?: Json
          thumbnail_path?: string | null
          updated_at?: string
          user_id?: string
          width?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
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

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
