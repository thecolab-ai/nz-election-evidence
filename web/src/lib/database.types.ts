// GENERATED FILE - do not edit. Regenerate with `npm run types:generate` (needs the local stack).
// Source: supabase gen types --local, schemas evidence_public and evidence_open (anonymous read-only).
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  evidence_open: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      bill_publication_sets: {
        Row: {
          bill_number: string | null
          bill_ref: string | null
          id: string | null
          index_status: string | null
          legislation_url: string | null
          publication_revision_count: number | null
          source_record_id: string | null
          title: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bill_publication_sets_source_record_id_fkey"
            columns: ["source_record_id"]
            isOneToOne: true
            referencedRelation: "source_records"
            referencedColumns: ["id"]
          },
        ]
      }
      bill_publications: {
        Row: {
          bill_number: string | null
          bill_ref: string | null
          bill_title: string | null
          file_bytes: number | null
          file_sha256: string | null
          id: string | null
          official_pdf_url: string | null
          revision_ref: string | null
          source_record_id: string | null
          version_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bill_publications_source_record_id_fkey"
            columns: ["source_record_id"]
            isOneToOne: true
            referencedRelation: "source_records"
            referencedColumns: ["id"]
          },
        ]
      }
      bill_stages: {
        Row: {
          bill_document_id: string | null
          evidence_version_id: string | null
          outcome_label: string | null
          stage_at: string | null
          stage_code: string | null
          stage_name: string | null
          stage_order: number | null
        }
        Relationships: [
          {
            foreignKeyName: "bill_stages_bill_document_id_fkey"
            columns: ["bill_document_id"]
            isOneToOne: false
            referencedRelation: "bills"
            referencedColumns: ["document_id"]
          },
          {
            foreignKeyName: "bill_stages_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      bills: {
        Row: {
          bill_number: string | null
          bill_type: string | null
          current_stage: string | null
          document_id: string | null
          introduced_at: string | null
          last_activity_at: string | null
          legislation_url: string | null
          member_identity_id: string | null
          member_name_at_source: string | null
          parliament_number: number | null
          party_label_at_source: string | null
          select_committee: string | null
          source_last_updated_at: string | null
          status_label: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bills_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bills_member_identity_id_fkey"
            columns: ["member_identity_id"]
            isOneToOne: false
            referencedRelation: "person_source_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      candidacies: {
        Row: {
          candidacy_type: string | null
          contest_id: string | null
          current_status: string | null
          election_id: string | null
          evidence_version_id: string | null
          id: string | null
          party_identity_id: string | null
          person_identity_id: string | null
          stood_as_independent: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "candidacies_contest_id_fkey"
            columns: ["contest_id"]
            isOneToOne: false
            referencedRelation: "contests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidacies_election_id_fkey"
            columns: ["election_id"]
            isOneToOne: false
            referencedRelation: "elections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidacies_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidacies_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidacies_person_identity_id_fkey"
            columns: ["person_identity_id"]
            isOneToOne: false
            referencedRelation: "person_source_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      candidacy_status_events: {
        Row: {
          candidacy_id: string | null
          date_precision: string | null
          evidence_version_id: string | null
          id: string | null
          recorded_at: string | null
          source_class: string | null
          status: string | null
          status_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidacy_status_events_candidacy_id_fkey"
            columns: ["candidacy_id"]
            isOneToOne: false
            referencedRelation: "candidacies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidacy_status_events_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_results: {
        Row: {
          candidacy_id: string | null
          result_set_id: string | null
          value_status: string | null
          vote_share: number | null
          votes: number | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_results_candidacy_id_fkey"
            columns: ["candidacy_id"]
            isOneToOne: false
            referencedRelation: "candidacies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_results_result_set_id_fkey"
            columns: ["result_set_id"]
            isOneToOne: false
            referencedRelation: "result_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      catalogue_product_map: {
        Row: {
          mapping_note: string | null
          product_id: string | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "catalogue_product_map_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      committee_business_items: {
        Row: {
          business_type: string | null
          committee: string | null
          document_id: string | null
          item_type: string | null
          parliament_number: number | null
          published_at: string | null
          source_last_modified_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "committee_business_items_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      committee_report_files: {
        Row: {
          attachment_ref: string | null
          file_bytes: number | null
          file_sha256: string | null
          id: string | null
          media_type: string | null
          official_download_url: string | null
          parent_report_ref: string | null
          published_at: string | null
          report_document_id: string | null
          source_record_id: string | null
          text_extraction_status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "committee_report_files_report_document_id_fkey"
            columns: ["report_document_id"]
            isOneToOne: false
            referencedRelation: "committee_reports"
            referencedColumns: ["document_id"]
          },
          {
            foreignKeyName: "committee_report_files_source_record_id_fkey"
            columns: ["source_record_id"]
            isOneToOne: true
            referencedRelation: "source_records"
            referencedColumns: ["id"]
          },
        ]
      }
      committee_reports: {
        Row: {
          attachment_ref: string | null
          committee: string | null
          document_id: string | null
          parliament_number: number | null
          report_type: string | null
          reported_on: string | null
          source_last_modified_at: string | null
          subtitle: string | null
        }
        Relationships: [
          {
            foreignKeyName: "committee_reports_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      contests: {
        Row: {
          contest_type: string | null
          election_id: string | null
          electorate_version_id: string | null
          id: string | null
        }
        Insert: {
          contest_type?: string | null
          election_id?: string | null
          electorate_version_id?: string | null
          id?: string | null
        }
        Update: {
          contest_type?: string | null
          election_id?: string | null
          electorate_version_id?: string | null
          id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contests_election_id_fkey"
            columns: ["election_id"]
            isOneToOne: false
            referencedRelation: "elections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contests_electorate_version_id_fkey"
            columns: ["electorate_version_id"]
            isOneToOne: false
            referencedRelation: "electorate_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      corrections: {
        Row: {
          confirmed_at: string | null
          corrections_log_reference: string | null
          description: string | null
          id: string | null
          recorded_at: string | null
          subject_id: string | null
          subject_kind: string | null
          supersedes_correction_id: string | null
        }
        Insert: {
          confirmed_at?: string | null
          corrections_log_reference?: string | null
          description?: string | null
          id?: string | null
          recorded_at?: string | null
          subject_id?: string | null
          subject_kind?: string | null
          supersedes_correction_id?: string | null
        }
        Update: {
          confirmed_at?: string | null
          corrections_log_reference?: string | null
          description?: string | null
          id?: string | null
          recorded_at?: string | null
          subject_id?: string | null
          subject_kind?: string | null
          supersedes_correction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "corrections_supersedes_correction_id_fkey"
            columns: ["supersedes_correction_id"]
            isOneToOne: false
            referencedRelation: "corrections"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          document_type: string | null
          id: string | null
          official_url: string | null
          source_record_id: string | null
          title: string | null
          view_scope: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_source_record_id_fkey"
            columns: ["source_record_id"]
            isOneToOne: true
            referencedRelation: "source_records"
            referencedColumns: ["id"]
          },
        ]
      }
      election_party_totals: {
        Row: {
          denominator_note: string | null
          electorate_seats: number | null
          list_seats: number | null
          party_identity_id: string | null
          party_vote_share: number | null
          party_votes: number | null
          result_set_id: string | null
          value_status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "election_party_totals_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "election_party_totals_result_set_id_fkey"
            columns: ["result_set_id"]
            isOneToOne: false
            referencedRelation: "result_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      elections: {
        Row: {
          election_date: string | null
          election_date_basis: string | null
          election_type: string | null
          id: string | null
          official_source_version_id: string | null
          slug: string | null
          status: string | null
          title: string | null
          view_scope: string | null
        }
        Insert: {
          election_date?: string | null
          election_date_basis?: string | null
          election_type?: string | null
          id?: string | null
          official_source_version_id?: string | null
          slug?: string | null
          status?: string | null
          title?: string | null
          view_scope?: string | null
        }
        Update: {
          election_date?: string | null
          election_date_basis?: string | null
          election_type?: string | null
          id?: string | null
          official_source_version_id?: string | null
          slug?: string | null
          status?: string | null
          title?: string | null
          view_scope?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "elections_official_source_version_id_fkey"
            columns: ["official_source_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      electorate_versions: {
        Row: {
          boundary_edition_id: string | null
          electorate_id: string | null
          electorate_type: string | null
          evidence_version_id: string | null
          id: string | null
          name: string | null
          official_code: string | null
        }
        Relationships: [
          {
            foreignKeyName: "electorate_versions_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      fetch_log: {
        Row: {
          attempt: number | null
          body_sha256: string | null
          duration_ms: number | null
          http_status: number | null
          id: number | null
          outcome: string | null
          request_host: string | null
          request_method: string | null
          request_url: string | null
          response_bytes: number | null
          retrieved_at: string | null
          run_id: string | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fetch_log_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fetch_log_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      finance_return_references: {
        Row: {
          approved_total: number | null
          candidacy_id: string | null
          document_id: string | null
          election_id: string | null
          filing_status: string | null
          filing_status_basis: string | null
          id: string | null
          is_image_only: boolean | null
          party_identity_id: string | null
          reporting_year: number | null
          return_type: string | null
          total_status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finance_return_references_candidacy_id_fkey"
            columns: ["candidacy_id"]
            isOneToOne: false
            referencedRelation: "candidacies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_return_references_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_return_references_election_id_fkey"
            columns: ["election_id"]
            isOneToOne: false
            referencedRelation: "elections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_return_references_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      identity_decisions: {
        Row: {
          decided_at: string | null
          decision: string | null
          evidence: Json | null
          id: string | null
          method: string | null
          party_identity_id: string | null
          person_identity_id: string | null
          subject_kind: string | null
          supersedes_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "identity_decisions_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "identity_decisions_person_identity_id_fkey"
            columns: ["person_identity_id"]
            isOneToOne: false
            referencedRelation: "person_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "identity_decisions_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "identity_decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      import_runs: {
        Row: {
          adapter_version: string | null
          complete_snapshot: boolean | null
          error_class: string | null
          finished_at: string | null
          id: string | null
          manifest_hash: string | null
          mode: string | null
          observations_inserted: number | null
          records_seen: number | null
          rejected: number | null
          resumed_from_run_id: string | null
          source_id: string | null
          started_at: string | null
          status: string | null
          tombstoned: number | null
          trigger_kind: string | null
          unchanged: number | null
          versions_inserted: number | null
        }
        Relationships: [
          {
            foreignKeyName: "import_runs_resumed_from_run_id_fkey"
            columns: ["resumed_from_run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_runs_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      ingest_errors: {
        Row: {
          error_class: string | null
          id: number | null
          occurred_at: string | null
          run_id: string | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingest_errors_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingest_errors_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      ingest_schedules: {
        Row: {
          activated_at: string | null
          activation_proof: Json | null
          config_hash: string | null
          cron_expr: string | null
          cron_jobid: number | null
          function_slug: string | null
          max_records: number | null
          max_runtime_seconds: number | null
          schedule_key: string | null
          source_id: string | null
          state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingest_schedules_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      model_runs: {
        Row: {
          id: string | null
          metadata_status: string | null
          model_name: string | null
          model_version: string | null
          parameters: Json | null
          prompt_or_schema_version: string | null
          provider: string | null
          started_at: string | null
        }
        Insert: {
          id?: string | null
          metadata_status?: string | null
          model_name?: string | null
          model_version?: string | null
          parameters?: Json | null
          prompt_or_schema_version?: string | null
          provider?: string | null
          started_at?: string | null
        }
        Update: {
          id?: string | null
          metadata_status?: string | null
          model_name?: string | null
          model_version?: string | null
          parameters?: Json | null
          prompt_or_schema_version?: string | null
          provider?: string | null
          started_at?: string | null
        }
        Relationships: []
      }
      owner_authorization_scopes: {
        Row: {
          authorization_id: string | null
          basis: string | null
          field_token: string | null
          rights_id: string | null
          scope_kind: string | null
          source_id: string | null
          surface_id: string | null
        }
        Insert: {
          authorization_id?: string | null
          basis?: string | null
          field_token?: string | null
          rights_id?: string | null
          scope_kind?: string | null
          source_id?: string | null
          surface_id?: string | null
        }
        Update: {
          authorization_id?: string | null
          basis?: string | null
          field_token?: string | null
          rights_id?: string | null
          scope_kind?: string | null
          source_id?: string | null
          surface_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "owner_authorization_scopes_authorization_id_fkey"
            columns: ["authorization_id"]
            isOneToOne: false
            referencedRelation: "owner_authorizations"
            referencedColumns: ["authorization_id"]
          },
          {
            foreignKeyName: "owner_authorization_scopes_rights_id_fkey"
            columns: ["rights_id"]
            isOneToOne: false
            referencedRelation: "source_rights"
            referencedColumns: ["rights_id"]
          },
          {
            foreignKeyName: "owner_authorization_scopes_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      owner_authorizations: {
        Row: {
          authorization_id: string | null
          decided_by_role: string | null
          decided_on: string | null
          entry_hash: string | null
          expires_on: string | null
          file_hash: string | null
          not_claimed: string[] | null
          recorded_at: string | null
          request_source: string | null
          revoked_at: string | null
          revoked_reason: string | null
          statement: string | null
        }
        Insert: {
          authorization_id?: string | null
          decided_by_role?: string | null
          decided_on?: string | null
          entry_hash?: string | null
          expires_on?: string | null
          file_hash?: string | null
          not_claimed?: string[] | null
          recorded_at?: string | null
          request_source?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          statement?: string | null
        }
        Update: {
          authorization_id?: string | null
          decided_by_role?: string | null
          decided_on?: string | null
          entry_hash?: string | null
          expires_on?: string | null
          file_hash?: string | null
          not_claimed?: string[] | null
          recorded_at?: string | null
          request_source?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          statement?: string | null
        }
        Relationships: []
      }
      parliamentary_service_terms: {
        Row: {
          basis: string | null
          date_precision: string | null
          electorate_name_at_source: string | null
          electorate_version_id: string | null
          evidence_version_id: string | null
          id: string | null
          observed_absent_at: string | null
          observed_first_at: string | null
          observed_last_at: string | null
          parliament_number: number | null
          party_identity_id: string | null
          person_identity_id: string | null
          representation: string | null
          valid_from: string | null
          valid_to: string | null
        }
        Relationships: [
          {
            foreignKeyName: "parliamentary_service_terms_electorate_version_id_fkey"
            columns: ["electorate_version_id"]
            isOneToOne: false
            referencedRelation: "electorate_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parliamentary_service_terms_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parliamentary_service_terms_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parliamentary_service_terms_person_identity_id_fkey"
            columns: ["person_identity_id"]
            isOneToOne: false
            referencedRelation: "person_source_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      party_affiliations: {
        Row: {
          basis: string | null
          date_precision: string | null
          evidence_version_id: string | null
          id: string | null
          observed_first_at: string | null
          observed_last_at: string | null
          party_identity_id: string | null
          person_identity_id: string | null
          valid_from: string | null
          valid_to: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_affiliations_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_affiliations_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_affiliations_person_identity_id_fkey"
            columns: ["person_identity_id"]
            isOneToOne: false
            referencedRelation: "person_source_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      party_list_entries: {
        Row: {
          candidacy_id: string | null
          list_id: string | null
          list_rank: number | null
          person_identity_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_list_entries_candidacy_id_fkey"
            columns: ["candidacy_id"]
            isOneToOne: false
            referencedRelation: "candidacies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_list_entries_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "party_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_list_entries_person_identity_id_fkey"
            columns: ["person_identity_id"]
            isOneToOne: false
            referencedRelation: "person_source_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      party_lists: {
        Row: {
          election_id: string | null
          evidence_version_id: string | null
          id: string | null
          list_version: number | null
          party_identity_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_lists_election_id_fkey"
            columns: ["election_id"]
            isOneToOne: false
            referencedRelation: "elections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_lists_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_lists_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      party_registrations: {
        Row: {
          date_precision: string | null
          evidence_version_id: string | null
          id: string | null
          party_identity_id: string | null
          status: string | null
          valid_from: string | null
          valid_to: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_registrations_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_registrations_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      party_results: {
        Row: {
          contest_id: string | null
          party_identity_id: string | null
          result_set_id: string | null
          value_status: string | null
          votes: number | null
        }
        Relationships: [
          {
            foreignKeyName: "party_results_contest_id_fkey"
            columns: ["contest_id"]
            isOneToOne: false
            referencedRelation: "contests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_results_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_results_result_set_id_fkey"
            columns: ["result_set_id"]
            isOneToOne: false
            referencedRelation: "result_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      party_source_identities: {
        Row: {
          created_at: string | null
          external_id: string | null
          id: string | null
          is_independent_label: boolean | null
          link_status: string | null
          name_at_source: string | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_source_identities_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      person_source_identities: {
        Row: {
          created_at: string | null
          external_id: string | null
          first_version_id: string | null
          id: string | null
          identity_scheme: string | null
          link_status: string | null
          name_at_source: string | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "person_source_identities_first_version_id_fkey"
            columns: ["first_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_source_identities_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      policy_sources: {
        Row: {
          classification_basis: string | null
          confidence: number | null
          confidence_basis: string | null
          confidence_status: string | null
          document_id: string | null
          election_id: string | null
          model_run_id: string | null
          party_identity_id: string | null
          policy_class: string | null
        }
        Relationships: [
          {
            foreignKeyName: "policy_sources_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "policy_sources_election_id_fkey"
            columns: ["election_id"]
            isOneToOne: false
            referencedRelation: "elections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "policy_sources_model_run_id_fkey"
            columns: ["model_run_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "policy_sources_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      poll_results: {
        Row: {
          party_identity_id: string | null
          party_label_at_source: string | null
          poll_document_id: string | null
          value_pct: number | null
          value_status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "poll_results_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_results_poll_document_id_fkey"
            columns: ["poll_document_id"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["document_id"]
          },
        ]
      }
      polls: {
        Row: {
          document_id: string | null
          fieldwork_end: string | null
          fieldwork_start: string | null
          methodology_status: string | null
          pollster: string | null
          sample_size: number | null
          sponsor: string | null
        }
        Relationships: [
          {
            foreignKeyName: "polls_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      public_columns: {
        Row: {
          column_name: string | null
          field_token: string | null
          object_name: string | null
          object_schema: string | null
          release_class: string | null
        }
        Insert: {
          column_name?: string | null
          field_token?: string | null
          object_name?: string | null
          object_schema?: string | null
          release_class?: string | null
        }
        Update: {
          column_name?: string | null
          field_token?: string | null
          object_name?: string | null
          object_schema?: string | null
          release_class?: string | null
        }
        Relationships: []
      }
      public_lineage: {
        Row: {
          lineage_kind: string | null
          lineage_sql: string | null
          note: string | null
          object_name: string | null
          object_schema: string | null
        }
        Insert: {
          lineage_kind?: string | null
          lineage_sql?: string | null
          note?: string | null
          object_name?: string | null
          object_schema?: string | null
        }
        Update: {
          lineage_kind?: string | null
          lineage_sql?: string | null
          note?: string | null
          object_name?: string | null
          object_schema?: string | null
        }
        Relationships: []
      }
      public_row_rules: {
        Row: {
          object_name: string | null
          object_schema: string | null
          predicate: string | null
          reason: string | null
        }
        Insert: {
          object_name?: string | null
          object_schema?: string | null
          predicate?: string | null
          reason?: string | null
        }
        Update: {
          object_name?: string | null
          object_schema?: string | null
          predicate?: string | null
          reason?: string | null
        }
        Relationships: []
      }
      public_withheld: {
        Row: {
          column_name: string | null
          object_name: string | null
          object_schema: string | null
          reason: string | null
        }
        Insert: {
          column_name?: string | null
          object_name?: string | null
          object_schema?: string | null
          reason?: string | null
        }
        Update: {
          column_name?: string | null
          object_name?: string | null
          object_schema?: string | null
          reason?: string | null
        }
        Relationships: []
      }
      publisher_access_checks: {
        Row: {
          body_sha256: string | null
          check_kind: string | null
          checked_at: string | null
          checked_host: string | null
          checked_url: string | null
          crawl_delay_seconds: number | null
          finding: string | null
          http_status: number | null
          id: number | null
          outcome: string | null
          recorded_at: string | null
          response_bytes: number | null
          source_id: string | null
          target_path: string | null
          tool_version: string | null
        }
        Relationships: [
          {
            foreignKeyName: "publisher_access_checks_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      publisher_terms_reviews: {
        Row: {
          automated_access: string | null
          id: number | null
          reviewed_at: string | null
          rights_id: string | null
          robots_check_id: number | null
          source_id: string | null
          terms_check_id: number | null
          terms_url: string | null
        }
        Relationships: [
          {
            foreignKeyName: "publisher_terms_reviews_rights_id_fkey"
            columns: ["rights_id"]
            isOneToOne: false
            referencedRelation: "source_rights"
            referencedColumns: ["rights_id"]
          },
          {
            foreignKeyName: "publisher_terms_reviews_robots_check_id_fkey"
            columns: ["robots_check_id"]
            isOneToOne: false
            referencedRelation: "publisher_access_checks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "publisher_terms_reviews_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
          {
            foreignKeyName: "publisher_terms_reviews_terms_check_id_fkey"
            columns: ["terms_check_id"]
            isOneToOne: false
            referencedRelation: "publisher_access_checks"
            referencedColumns: ["id"]
          },
        ]
      }
      record_lifecycle_events: {
        Row: {
          event: string | null
          id: number | null
          occurred_at: string | null
          record_id: string | null
          run_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "record_lifecycle_events_record_id_fkey"
            columns: ["record_id"]
            isOneToOne: false
            referencedRelation: "source_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "record_lifecycle_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      record_route_keys: {
        Row: {
          item_family: string | null
          record_id: string | null
          route_key: string | null
        }
        Relationships: [
          {
            foreignKeyName: "record_route_keys_record_id_fkey"
            columns: ["record_id"]
            isOneToOne: true
            referencedRelation: "source_records"
            referencedColumns: ["id"]
          },
        ]
      }
      registry_products: {
        Row: {
          domain: string | null
          notes: string | null
          registry_key: string | null
          title: string | null
        }
        Insert: {
          domain?: string | null
          notes?: string | null
          registry_key?: string | null
          title?: string | null
        }
        Update: {
          domain?: string | null
          notes?: string | null
          registry_key?: string | null
          title?: string | null
        }
        Relationships: []
      }
      release_attributions: {
        Row: {
          content_kind: string | null
          id: string | null
          minister_names_at_source: string[] | null
          official_url: string | null
          portfolio_names_at_source: string[] | null
          source_record_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "release_attributions_source_record_id_fkey"
            columns: ["source_record_id"]
            isOneToOne: true
            referencedRelation: "source_records"
            referencedColumns: ["id"]
          },
        ]
      }
      release_batches: {
        Row: {
          created_at: string | null
          id: string | null
          released_at: string | null
          status: string | null
          withdrawal_reason: string | null
          withdrawn_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string | null
          released_at?: string | null
          status?: string | null
          withdrawal_reason?: string | null
          withdrawn_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string | null
          released_at?: string | null
          status?: string | null
          withdrawal_reason?: string | null
          withdrawn_at?: string | null
        }
        Relationships: []
      }
      release_gates: {
        Row: {
          decided_at: string | null
          evidence_reference: string | null
          gate_key: string | null
          state: string | null
        }
        Insert: {
          decided_at?: string | null
          evidence_reference?: string | null
          gate_key?: string | null
          state?: string | null
        }
        Update: {
          decided_at?: string | null
          evidence_reference?: string | null
          gate_key?: string | null
          state?: string | null
        }
        Relationships: []
      }
      release_items: {
        Row: {
          batch_id: string | null
          document_id: string | null
          item_kind: string | null
          source_id: string | null
          version_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "release_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "release_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "release_items_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "release_items_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
          {
            foreignKeyName: "release_items_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      releases: {
        Row: {
          document_id: string | null
          published_at: string | null
          publisher_item_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "releases_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      result_sets: {
        Row: {
          declared_on: string | null
          election_id: string | null
          id: string | null
          result_status: string | null
          source_version_id: string | null
          supersedes_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "result_sets_election_id_fkey"
            columns: ["election_id"]
            isOneToOne: false
            referencedRelation: "elections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "result_sets_source_version_id_fkey"
            columns: ["source_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "result_sets_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "result_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      review_decisions: {
        Row: {
          decided_at: string | null
          decision: string | null
          id: string | null
          rubric_version: string | null
          subject_hash: string | null
          subject_id: string | null
          subject_kind: string | null
        }
        Insert: {
          decided_at?: string | null
          decision?: string | null
          id?: string | null
          rubric_version?: string | null
          subject_hash?: string | null
          subject_id?: string | null
          subject_kind?: string | null
        }
        Update: {
          decided_at?: string | null
          decision?: string | null
          id?: string | null
          rubric_version?: string | null
          subject_hash?: string | null
          subject_id?: string | null
          subject_kind?: string | null
        }
        Relationships: []
      }
      rights_decisions: {
        Row: {
          decided_at: string | null
          decision: string | null
          evidence_url: string | null
          id: string | null
          rights_id: string | null
          scope_fields: string[] | null
        }
        Insert: {
          decided_at?: string | null
          decision?: string | null
          evidence_url?: string | null
          id?: string | null
          rights_id?: string | null
          scope_fields?: string[] | null
        }
        Update: {
          decided_at?: string | null
          decision?: string | null
          evidence_url?: string | null
          id?: string | null
          rights_id?: string | null
          scope_fields?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "rights_decisions_rights_id_fkey"
            columns: ["rights_id"]
            isOneToOne: false
            referencedRelation: "source_rights"
            referencedColumns: ["rights_id"]
          },
        ]
      }
      role_terms: {
        Row: {
          date_precision: string | null
          evidence_version_id: string | null
          id: string | null
          observed_first_at: string | null
          observed_last_at: string | null
          person_identity_id: string | null
          role_title: string | null
          role_type: string | null
          valid_from: string | null
          valid_to: string | null
        }
        Relationships: [
          {
            foreignKeyName: "role_terms_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_terms_person_identity_id_fkey"
            columns: ["person_identity_id"]
            isOneToOne: false
            referencedRelation: "person_source_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      run_checkpoints: {
        Row: {
          created_at: string | null
          records_so_far: number | null
          run_id: string | null
          seq: number | null
        }
        Relationships: [
          {
            foreignKeyName: "run_checkpoints_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_projectors: {
        Row: {
          function_name: string | null
          projector_key: string | null
          registered_at: string | null
        }
        Insert: {
          function_name?: string | null
          projector_key?: string | null
          registered_at?: string | null
        }
        Update: {
          function_name?: string | null
          projector_key?: string | null
          registered_at?: string | null
        }
        Relationships: []
      }
      schedule_dispatch_log: {
        Row: {
          dispatched_at: string | null
          id: number | null
          net_request_id: number | null
          outcome: string | null
          schedule_key: string | null
        }
        Relationships: [
          {
            foreignKeyName: "schedule_dispatch_log_schedule_key_fkey"
            columns: ["schedule_key"]
            isOneToOne: false
            referencedRelation: "ingest_schedules"
            referencedColumns: ["schedule_key"]
          },
        ]
      }
      schema_agreement_validations: {
        Row: {
          agreement_rate: number | null
          agreements: number | null
          id: string | null
          method_url: string | null
          output_kind: string | null
          prompt_or_schema_version: string | null
          sample_size: number | null
          validated_at: string | null
        }
        Insert: {
          agreement_rate?: number | null
          agreements?: number | null
          id?: string | null
          method_url?: string | null
          output_kind?: string | null
          prompt_or_schema_version?: string | null
          sample_size?: number | null
          validated_at?: string | null
        }
        Update: {
          agreement_rate?: number | null
          agreements?: number | null
          id?: string | null
          method_url?: string | null
          output_kind?: string | null
          prompt_or_schema_version?: string | null
          sample_size?: number | null
          validated_at?: string | null
        }
        Relationships: []
      }
      source_freshness: {
        Row: {
          consecutive_failures: number | null
          last_attempt_at: string | null
          last_attempt_run_id: string | null
          last_attempt_status: string | null
          last_change_at: string | null
          last_error_class: string | null
          last_success_at: string | null
          last_success_run_id: string | null
          latest_source_published_at: string | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_freshness_last_attempt_run_id_fkey"
            columns: ["last_attempt_run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_freshness_last_success_run_id_fkey"
            columns: ["last_success_run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_freshness_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: true
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      source_leases: {
        Row: {
          acquired_at: string | null
          expires_at: string | null
          heartbeat_at: string | null
          run_id: string | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_leases_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_leases_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: true
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      source_observations: {
        Row: {
          observed_at: string | null
          run_id: string | null
          version_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_observations_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_observations_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      source_record_versions: {
        Row: {
          content_hash: string | null
          first_retrieved_at: string | null
          id: string | null
          import_run_id: string | null
          loaded_at: string | null
          omitted_fields: Json | null
          original_content_hash: string | null
          predecessor_id: string | null
          projection_version: number | null
          record_id: string | null
          record_kind: string | null
          safe_payload: Json | null
          source_date_text: string | null
          source_published_at: string | null
          source_url: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_record_versions_import_run_id_fkey"
            columns: ["import_run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_record_versions_predecessor_id_fkey"
            columns: ["predecessor_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_record_versions_record_id_fkey"
            columns: ["record_id"]
            isOneToOne: false
            referencedRelation: "source_records"
            referencedColumns: ["id"]
          },
        ]
      }
      source_records: {
        Row: {
          current_version_id: string | null
          external_record_id: string | null
          first_seen_at: string | null
          id: string | null
          last_seen_at: string | null
          record_kind: string | null
          source_id: string | null
          tombstone_reason: string | null
          tombstoned_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_records_current_version_same_record"
            columns: ["current_version_id", "id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id", "record_id"]
          },
          {
            foreignKeyName: "source_records_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      source_rights: {
        Row: {
          approved_fields: string[] | null
          attribution: string | null
          default_release: string | null
          excluded_assets: string | null
          licence_or_terms_url: string | null
          publisher: string | null
          register_hash: string | null
          review_status: string | null
          reviewed_on: string | null
          rights_id: string | null
          source_url: string | null
          synced_at: string | null
          verified_permissions: string | null
        }
        Insert: {
          approved_fields?: string[] | null
          attribution?: string | null
          default_release?: string | null
          excluded_assets?: string | null
          licence_or_terms_url?: string | null
          publisher?: string | null
          register_hash?: string | null
          review_status?: string | null
          reviewed_on?: string | null
          rights_id?: string | null
          source_url?: string | null
          synced_at?: string | null
          verified_permissions?: string | null
        }
        Update: {
          approved_fields?: string[] | null
          attribution?: string | null
          default_release?: string | null
          excluded_assets?: string | null
          licence_or_terms_url?: string | null
          publisher?: string | null
          register_hash?: string | null
          review_status?: string | null
          reviewed_on?: string | null
          rights_id?: string | null
          source_url?: string | null
          synced_at?: string | null
          verified_permissions?: string | null
        }
        Relationships: []
      }
      sources: {
        Row: {
          access_basis: string | null
          adapter_kind: string | null
          adapter_name: string | null
          allowed_hosts: string[] | null
          blocked_reason: string | null
          config_hash: string | null
          enabled: boolean | null
          expected_cadence_seconds: number | null
          known_access_restriction: string | null
          official_url: string | null
          publisher: string | null
          registry_key: string | null
          rights_id: string | null
          snapshot_semantics: string | null
          source_id: string | null
          synced_at: string | null
          title: string | null
          view_scope: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sources_registry_key_fkey"
            columns: ["registry_key"]
            isOneToOne: false
            referencedRelation: "registry_products"
            referencedColumns: ["registry_key"]
          },
          {
            foreignKeyName: "sources_rights_id_fkey"
            columns: ["rights_id"]
            isOneToOne: false
            referencedRelation: "source_rights"
            referencedColumns: ["rights_id"]
          },
        ]
      }
      staged_unmatched_results: {
        Row: {
          id: string | null
          label_at_source: string | null
          reason: string | null
          result_set_id: string | null
          safe_payload: Json | null
          staged_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staged_unmatched_results_result_set_id_fkey"
            columns: ["result_set_id"]
            isOneToOne: false
            referencedRelation: "result_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      stat_datasets: {
        Row: {
          dataset_key: string | null
          id: string | null
          publisher: string | null
          source_id: string | null
          title: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stat_datasets_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      stat_observations: {
        Row: {
          canonical_route: string | null
          content_hash: string | null
          geography_version_id: string | null
          id: number | null
          import_run_id: string | null
          parse_status: string | null
          period_end: string | null
          period_label: string | null
          period_start: string | null
          raw_value: string | null
          release_id: string | null
          row_locator: string | null
          series_id: string | null
          value: number | null
          value_double: number | null
          value_status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stat_observations_import_run_id_fkey"
            columns: ["import_run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stat_observations_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: false
            referencedRelation: "stat_releases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stat_observations_series_id_fkey"
            columns: ["series_id"]
            isOneToOne: false
            referencedRelation: "stat_series"
            referencedColumns: ["id"]
          },
        ]
      }
      stat_releases: {
        Row: {
          dataset_id: string | null
          id: string | null
          release_key: string | null
          released_on: string | null
          source_snapshot_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stat_releases_dataset_id_fkey"
            columns: ["dataset_id"]
            isOneToOne: false
            referencedRelation: "stat_datasets"
            referencedColumns: ["id"]
          },
        ]
      }
      stat_route_reconciliation: {
        Row: {
          canonical_route: string | null
          decided_at: string | null
          decision_note: string | null
          observation_family: string | null
          overlapping_routes: string[] | null
          upstream_rows_by_route: Json | null
        }
        Insert: {
          canonical_route?: string | null
          decided_at?: string | null
          decision_note?: string | null
          observation_family?: string | null
          overlapping_routes?: string[] | null
          upstream_rows_by_route?: Json | null
        }
        Update: {
          canonical_route?: string | null
          decided_at?: string | null
          decision_note?: string | null
          observation_family?: string | null
          overlapping_routes?: string[] | null
          upstream_rows_by_route?: Json | null
        }
        Relationships: []
      }
      stat_series: {
        Row: {
          dataset_id: string | null
          dimensions: Json | null
          id: string | null
          magnitude: string | null
          seasonal_adjustment: string | null
          series_key: string | null
          title: string | null
          unit: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stat_series_dataset_id_fkey"
            columns: ["dataset_id"]
            isOneToOne: false
            referencedRelation: "stat_datasets"
            referencedColumns: ["id"]
          },
        ]
      }
      summary_inputs: {
        Row: {
          summary_id: string | null
          version_id: string | null
        }
        Insert: {
          summary_id?: string | null
          version_id?: string | null
        }
        Update: {
          summary_id?: string | null
          version_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "summary_inputs_summary_id_fkey"
            columns: ["summary_id"]
            isOneToOne: false
            referencedRelation: "summary_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "summary_inputs_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      summary_versions: {
        Row: {
          confidence: number | null
          confidence_basis: string | null
          confidence_status: string | null
          created_at: string | null
          id: string | null
          model_run_id: string | null
          output_hash: string | null
          review_status: string | null
          summary_text: string | null
          uncertainty_note: string | null
        }
        Insert: {
          confidence?: number | null
          confidence_basis?: string | null
          confidence_status?: string | null
          created_at?: string | null
          id?: string | null
          model_run_id?: string | null
          output_hash?: string | null
          review_status?: string | null
          summary_text?: string | null
          uncertainty_note?: string | null
        }
        Update: {
          confidence?: number | null
          confidence_basis?: string | null
          confidence_status?: string | null
          created_at?: string | null
          id?: string | null
          model_run_id?: string | null
          output_hash?: string | null
          review_status?: string | null
          summary_text?: string | null
          uncertainty_note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "summary_versions_model_run_id_fkey"
            columns: ["model_run_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      version_bill_links: {
        Row: {
          bill_document_id: string | null
          id: string | null
          method: string | null
          relationship_type: string | null
          review_status: string | null
          version_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "version_bill_links_bill_document_id_fkey"
            columns: ["bill_document_id"]
            isOneToOne: false
            referencedRelation: "bills"
            referencedColumns: ["document_id"]
          },
          {
            foreignKeyName: "version_bill_links_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      version_electorate_links: {
        Row: {
          electorate_version_id: string | null
          id: string | null
          method: string | null
          relationship_type: string | null
          review_status: string | null
          version_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "version_electorate_links_electorate_version_id_fkey"
            columns: ["electorate_version_id"]
            isOneToOne: false
            referencedRelation: "electorate_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "version_electorate_links_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      version_party_links: {
        Row: {
          evidence_locator: string | null
          id: string | null
          method: string | null
          party_identity_id: string | null
          relationship_type: string | null
          review_status: string | null
          version_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "version_party_links_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "version_party_links_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      version_person_links: {
        Row: {
          evidence_locator: string | null
          id: string | null
          method: string | null
          person_identity_id: string | null
          relationship_type: string | null
          review_status: string | null
          version_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "version_person_links_person_identity_id_fkey"
            columns: ["person_identity_id"]
            isOneToOne: false
            referencedRelation: "person_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "version_person_links_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "source_record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      written_questions: {
        Row: {
          answer_status: string | null
          answered_by_identity_id: string | null
          answered_on: string | null
          asked_by_identity_id: string | null
          asker_member_ref: string | null
          asker_name_at_source: string | null
          attachment_present: boolean | null
          document_id: string | null
          document_ref: string | null
          lodged_on: string | null
          minister_name_at_source: string | null
          ministerial_title_at_source: string | null
          parliament_number: number | null
          portfolio: string | null
          portfolio_ref: string | null
          question_number: string | null
          question_year: number | null
          released_on: string | null
          reply_present: boolean | null
          source_last_modified_at: string | null
          status_ref: number | null
        }
        Relationships: [
          {
            foreignKeyName: "written_questions_answered_by_identity_id_fkey"
            columns: ["answered_by_identity_id"]
            isOneToOne: false
            referencedRelation: "person_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "written_questions_asked_by_identity_id_fkey"
            columns: ["asked_by_identity_id"]
            isOneToOne: false
            referencedRelation: "person_source_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "written_questions_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
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
  evidence_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      candidacies: {
        Row: {
          candidacy_type: string | null
          candidate_name: string | null
          contest_id: string | null
          current_status: string | null
          election_slug: string | null
          electorate_name: string | null
          electorate_type: string | null
          electorate_version_id: string | null
          evidence_version_id: string | null
          id: string | null
          identity_link_status: string | null
          list_rank: number | null
          party_identity_id: string | null
          party_label: string | null
          person_identity_id: string | null
          result_status: string | null
          stood_as_independent: boolean | null
          view_scope: string | null
          votes: number | null
          votes_status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidacies_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidacies_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidacies_person_identity_id_fkey"
            columns: ["person_identity_id"]
            isOneToOne: false
            referencedRelation: "person_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contests_electorate_version_id_fkey"
            columns: ["electorate_version_id"]
            isOneToOne: false
            referencedRelation: "electorates"
            referencedColumns: ["id"]
          },
        ]
      }
      candidacy_status_events: {
        Row: {
          candidacy_id: string | null
          date_precision: string | null
          evidence_version_id: string | null
          id: string | null
          recorded_at: string | null
          source_class: string | null
          status: string | null
          status_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidacy_status_events_candidacy_id_fkey"
            columns: ["candidacy_id"]
            isOneToOne: false
            referencedRelation: "candidacies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidacy_status_events_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      dataset_catalogue: {
        Row: {
          approximate_rows: number | null
          columns_rights_gated: number | null
          columns_total: number | null
          columns_withheld: number | null
          dataset: string | null
          dataset_kind: string | null
          description: string | null
          disposition: string | null
          exposed_schema: string | null
          lineage_kind: string | null
          lineage_note: string | null
          row_rule_reason: string | null
          withheld_reason: string | null
        }
        Relationships: []
      }
      dataset_columns: {
        Row: {
          column_name: string | null
          data_type: string | null
          dataset: string | null
          description: string | null
          disposition: string | null
          exposed_schema: string | null
          field_token: string | null
          nullable: boolean | null
          ordinal: number | null
          withheld_reason: string | null
        }
        Relationships: []
      }
      documents: {
        Row: {
          bill_number: string | null
          bill_type: string | null
          current_stage: string | null
          current_version_id: string | null
          document_type: string | null
          first_retrieved_at: string | null
          id: string | null
          last_activity_at: string | null
          member_name_at_source: string | null
          official_url: string | null
          parliament_number: number | null
          party_label_at_source: string | null
          select_committee: string | null
          source_id: string | null
          source_published_at: string | null
          source_record_id: string | null
          title: string | null
          tombstoned_at: string | null
          view_scope: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_source_record_id_fkey"
            columns: ["source_record_id"]
            isOneToOne: true
            referencedRelation: "records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_records_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      elections: {
        Row: {
          election_date: string | null
          election_date_basis: string | null
          election_type: string | null
          id: string | null
          slug: string | null
          status: string | null
          title: string | null
          view_scope: string | null
        }
        Insert: {
          election_date?: string | null
          election_date_basis?: string | null
          election_type?: string | null
          id?: string | null
          slug?: string | null
          status?: string | null
          title?: string | null
          view_scope?: string | null
        }
        Update: {
          election_date?: string | null
          election_date_basis?: string | null
          election_type?: string | null
          id?: string | null
          slug?: string | null
          status?: string | null
          title?: string | null
          view_scope?: string | null
        }
        Relationships: []
      }
      electorates: {
        Row: {
          boundary_edition: string | null
          boundary_edition_title: string | null
          boundary_edition_verified: boolean | null
          electorate_id: string | null
          electorate_type: string | null
          evidence_version_id: string | null
          id: string | null
          name: string | null
          official_code: string | null
          slug: string | null
        }
        Relationships: [
          {
            foreignKeyName: "electorate_versions_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "record_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      fetch_log: {
        Row: {
          attempt: number | null
          body_sha256: string | null
          duration_ms: number | null
          http_status: number | null
          id: number | null
          outcome: string | null
          request_host: string | null
          request_method: string | null
          request_url: string | null
          response_bytes: number | null
          retrieved_at: string | null
          run_id: string | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fetch_log_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fetch_log_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      finance_returns: {
        Row: {
          approved_total: number | null
          candidacy_id: string | null
          document_id: string | null
          filing_status: string | null
          filing_status_basis: string | null
          id: string | null
          is_image_only: boolean | null
          official_url: string | null
          party_identity_id: string | null
          reporting_year: number | null
          return_type: string | null
          total_status: string | null
          view_scope: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finance_return_references_candidacy_id_fkey"
            columns: ["candidacy_id"]
            isOneToOne: false
            referencedRelation: "candidacies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_return_references_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_return_references_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      graph_edges: {
        Row: {
          edge_id: string | null
          evidence_version_id: string | null
          from_id: string | null
          from_kind: string | null
          from_label: string | null
          relationship: string | null
          to_id: string | null
          to_kind: string | null
          to_label: string | null
        }
        Relationships: []
      }
      identity_decisions: {
        Row: {
          decided_at: string | null
          decision: string | null
          evidence: Json | null
          id: string | null
          method: string | null
          party_identity_id: string | null
          person_identity_id: string | null
          subject_kind: string | null
          supersedes_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "identity_decisions_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "identity_decisions_person_identity_id_fkey"
            columns: ["person_identity_id"]
            isOneToOne: false
            referencedRelation: "person_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "identity_decisions_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "identity_decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      import_runs: {
        Row: {
          adapter_version: string | null
          checkpoints: number | null
          complete_snapshot: boolean | null
          error_class: string | null
          finished_at: string | null
          id: string | null
          manifest_hash: string | null
          mode: string | null
          observations_inserted: number | null
          records_seen: number | null
          rejected: number | null
          resumed_from_run_id: string | null
          source_id: string | null
          started_at: string | null
          status: string | null
          tombstoned: number | null
          trigger_kind: string | null
          unchanged: number | null
          versions_inserted: number | null
        }
        Relationships: [
          {
            foreignKeyName: "import_runs_resumed_from_run_id_fkey"
            columns: ["resumed_from_run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_runs_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      ingest_errors: {
        Row: {
          error_class: string | null
          id: number | null
          occurred_at: string | null
          run_id: string | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingest_errors_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingest_errors_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      party_affiliations: {
        Row: {
          basis: string | null
          date_precision: string | null
          evidence_version_id: string | null
          id: string | null
          observed_first_at: string | null
          observed_last_at: string | null
          party_identity_id: string | null
          party_label: string | null
          person_identity_id: string | null
          person_name: string | null
          valid_from: string | null
          valid_to: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_affiliations_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_affiliations_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_affiliations_person_identity_id_fkey"
            columns: ["person_identity_id"]
            isOneToOne: false
            referencedRelation: "person_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      party_identities: {
        Row: {
          external_id: string | null
          id: string | null
          is_independent_label: boolean | null
          link_status: string | null
          name_at_source: string | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_source_identities_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      person_identities: {
        Row: {
          candidacies: number | null
          external_id: string | null
          first_version_id: string | null
          id: string | null
          identity_scheme: string | null
          link_status: string | null
          name_at_source: string | null
          open_proposals: number | null
          service_terms: number | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "person_source_identities_first_version_id_fkey"
            columns: ["first_version_id"]
            isOneToOne: false
            referencedRelation: "record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_source_identities_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      policy_classifications: {
        Row: {
          classification_basis: string | null
          confidence: number | null
          confidence_basis: string | null
          confidence_status: string | null
          document_id: string | null
          election_id: string | null
          model_metadata_status: string | null
          model_name: string | null
          model_run_id: string | null
          model_version: string | null
          official_url: string | null
          party_identity_id: string | null
          policy_class: string | null
          prompt_or_schema_version: string | null
          provider: string | null
          schema_agreement_documented: boolean | null
          schema_agreement_method_url: string | null
          schema_agreement_rate: number | null
          schema_agreement_sample: number | null
          view_scope: string | null
        }
        Relationships: [
          {
            foreignKeyName: "policy_sources_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "policy_sources_election_id_fkey"
            columns: ["election_id"]
            isOneToOne: false
            referencedRelation: "elections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "policy_sources_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      polls: {
        Row: {
          document_id: string | null
          fieldwork_end: string | null
          fieldwork_start: string | null
          methodology_status: string | null
          official_url: string | null
          pollster: string | null
          sample_size: number | null
          sponsor: string | null
        }
        Relationships: [
          {
            foreignKeyName: "polls_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      record_lifecycle_events: {
        Row: {
          event: string | null
          id: number | null
          occurred_at: string | null
          record_id: string | null
          run_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "record_lifecycle_events_record_id_fkey"
            columns: ["record_id"]
            isOneToOne: false
            referencedRelation: "records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "record_lifecycle_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      record_versions: {
        Row: {
          content_hash: string | null
          first_retrieved_at: string | null
          id: string | null
          import_run_id: string | null
          is_current: boolean | null
          last_observed_at: string | null
          loaded_at: string | null
          observation_count: number | null
          omitted_fields: Json | null
          original_content_hash: string | null
          predecessor_id: string | null
          projection_version: number | null
          record_id: string | null
          record_kind: string | null
          safe_payload: Json | null
          source_date_text: string | null
          source_id: string | null
          source_published_at: string | null
          source_url: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_record_versions_import_run_id_fkey"
            columns: ["import_run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_record_versions_predecessor_id_fkey"
            columns: ["predecessor_id"]
            isOneToOne: false
            referencedRelation: "record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_record_versions_record_id_fkey"
            columns: ["record_id"]
            isOneToOne: false
            referencedRelation: "records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_records_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      records: {
        Row: {
          current_content_hash: string | null
          current_version_first_retrieved_at: string | null
          current_version_id: string | null
          external_record_id: string | null
          first_seen_at: string | null
          id: string | null
          label: string | null
          last_seen_at: string | null
          record_kind: string | null
          source_date_text: string | null
          source_id: string | null
          source_published_at: string | null
          source_url: string | null
          tombstone_reason: string | null
          tombstoned_at: string | null
          version_count: number | null
          view_scope: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_records_current_version_same_record"
            columns: ["current_version_id", "id"]
            isOneToOne: false
            referencedRelation: "record_versions"
            referencedColumns: ["id", "record_id"]
          },
          {
            foreignKeyName: "source_records_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      release_gates: {
        Row: {
          decided_at: string | null
          evidence_reference: string | null
          gate_key: string | null
          state: string | null
        }
        Insert: {
          decided_at?: string | null
          evidence_reference?: string | null
          gate_key?: string | null
          state?: string | null
        }
        Update: {
          decided_at?: string | null
          evidence_reference?: string | null
          gate_key?: string | null
          state?: string | null
        }
        Relationships: []
      }
      rights_register: {
        Row: {
          attribution: string | null
          default_release: string | null
          excluded_assets: string | null
          licence_or_terms_url: string | null
          publisher: string | null
          review_status: string | null
          reviewed_on: string | null
          rights_id: string | null
          source_url: string | null
          synced_at: string | null
          verified_permissions: string | null
        }
        Insert: {
          attribution?: string | null
          default_release?: string | null
          excluded_assets?: string | null
          licence_or_terms_url?: string | null
          publisher?: string | null
          review_status?: string | null
          reviewed_on?: string | null
          rights_id?: string | null
          source_url?: string | null
          synced_at?: string | null
          verified_permissions?: string | null
        }
        Update: {
          attribution?: string | null
          default_release?: string | null
          excluded_assets?: string | null
          licence_or_terms_url?: string | null
          publisher?: string | null
          review_status?: string | null
          reviewed_on?: string | null
          rights_id?: string | null
          source_url?: string | null
          synced_at?: string | null
          verified_permissions?: string | null
        }
        Relationships: []
      }
      schedules: {
        Row: {
          activated_at: string | null
          activation_proof: Json | null
          cron_expr: string | null
          cron_jobid: number | null
          function_slug: string | null
          last_dispatch_at: string | null
          last_dispatch_outcome: string | null
          max_records: number | null
          max_runtime_seconds: number | null
          schedule_key: string | null
          source_id: string | null
          state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingest_schedules_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      service_terms: {
        Row: {
          basis: string | null
          date_precision: string | null
          electorate_name_at_source: string | null
          electorate_version_id: string | null
          evidence_version_id: string | null
          id: string | null
          member_name: string | null
          observed_absent_at: string | null
          observed_first_at: string | null
          observed_last_at: string | null
          parliament_number: number | null
          party_identity_id: string | null
          party_label: string | null
          person_identity_id: string | null
          representation: string | null
          source_id: string | null
          valid_from: string | null
          valid_to: string | null
        }
        Relationships: [
          {
            foreignKeyName: "parliamentary_service_terms_electorate_version_id_fkey"
            columns: ["electorate_version_id"]
            isOneToOne: false
            referencedRelation: "electorates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parliamentary_service_terms_evidence_version_id_fkey"
            columns: ["evidence_version_id"]
            isOneToOne: false
            referencedRelation: "record_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parliamentary_service_terms_party_identity_id_fkey"
            columns: ["party_identity_id"]
            isOneToOne: false
            referencedRelation: "party_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parliamentary_service_terms_person_identity_id_fkey"
            columns: ["person_identity_id"]
            isOneToOne: false
            referencedRelation: "person_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_source_identities_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      sources: {
        Row: {
          adapter_kind: string | null
          adapter_name: string | null
          allowed_hosts: string[] | null
          blocked_reason: string | null
          catalogue_product_ids: string[] | null
          consecutive_failures: number | null
          content_versions: number | null
          enabled: boolean | null
          expected_cadence_seconds: number | null
          freshness_status: string | null
          last_attempt_at: string | null
          last_attempt_status: string | null
          last_change_at: string | null
          last_error_class: string | null
          last_success_at: string | null
          latest_source_published_at: string | null
          live_records: number | null
          official_url: string | null
          owner_authorized_fields: string[] | null
          public_approved_fields: string[] | null
          public_release_tier: string | null
          publisher: string | null
          registry_key: string | null
          rights_default_release: string | null
          rights_id: string | null
          rights_review_status: string | null
          snapshot_semantics: string | null
          source_id: string | null
          title: string | null
          tombstoned_records: number | null
          view_scope: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sources_rights_id_fkey"
            columns: ["rights_id"]
            isOneToOne: false
            referencedRelation: "rights_register"
            referencedColumns: ["rights_id"]
          },
        ]
      }
      stat_observations: {
        Row: {
          canonical_route: string | null
          geography_code: string | null
          geography_edition: string | null
          geography_name: string | null
          geography_scheme: string | null
          id: number | null
          parse_status: string | null
          period_end: string | null
          period_label: string | null
          period_start: string | null
          raw_value: string | null
          release_key: string | null
          released_on: string | null
          row_locator: string | null
          series_id: string | null
          value: number | null
          value_double: number | null
          value_status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stat_observations_series_id_fkey"
            columns: ["series_id"]
            isOneToOne: false
            referencedRelation: "stat_series"
            referencedColumns: ["id"]
          },
        ]
      }
      stat_route_reconciliation: {
        Row: {
          canonical_route: string | null
          decided_at: string | null
          decision_note: string | null
          observation_family: string | null
          overlapping_routes: string[] | null
          upstream_rows_by_route: Json | null
        }
        Insert: {
          canonical_route?: string | null
          decided_at?: string | null
          decision_note?: string | null
          observation_family?: string | null
          overlapping_routes?: string[] | null
          upstream_rows_by_route?: Json | null
        }
        Update: {
          canonical_route?: string | null
          decided_at?: string | null
          decision_note?: string | null
          observation_family?: string | null
          overlapping_routes?: string[] | null
          upstream_rows_by_route?: Json | null
        }
        Relationships: []
      }
      stat_series: {
        Row: {
          dataset_key: string | null
          dataset_title: string | null
          dimensions: Json | null
          id: string | null
          magnitude: string | null
          observations: number | null
          seasonal_adjustment: string | null
          series_key: string | null
          source_id: string | null
          title: string | null
          unit: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stat_datasets_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["source_id"]
          },
        ]
      }
      summaries: {
        Row: {
          confidence: number | null
          confidence_basis: string | null
          confidence_status: string | null
          created_at: string | null
          id: string | null
          model_metadata_status: string | null
          model_name: string | null
          model_version: string | null
          output_hash: string | null
          prompt_or_schema_version: string | null
          provider: string | null
          review_status: string | null
          schema_agreement_documented: boolean | null
          schema_agreement_method_url: string | null
          schema_agreement_rate: number | null
          schema_agreement_sample: number | null
          schema_agreement_validated_at: string | null
          summary_text: string | null
          uncertainty_note: string | null
        }
        Relationships: []
      }
      surface_status: {
        Row: {
          decided_at: string | null
          evidence_reference: string | null
          gate_key: string | null
          owner_authorization_id: string | null
          owner_decided_on: string | null
          owner_expires_on: string | null
          owner_fields_in_force: boolean | null
          owner_request_source: string | null
          public_rows_released: boolean | null
          release_basis: string | null
          state: string | null
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
  evidence_open: {
    Enums: {},
  },
  evidence_public: {
    Enums: {},
  },
} as const
