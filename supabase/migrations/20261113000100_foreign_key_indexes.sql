-- Indexes on foreign keys flagged by the Supabase performance advisor.
-- They keep joins fast and stop deletes on the parent table from scanning the whole child table.
create index admin_actions_admin_idx on public.admin_actions (admin_id);
create index plate_views_viewer_idx on public.plate_views (viewer_id);
create index plates_reviewed_by_idx on public.plates (reviewed_by);
create index purchase_requests_conversation_idx on public.purchase_requests (conversation_id);
create index reports_handled_by_idx on public.reports (handled_by);
create index reports_plate_idx on public.reports (plate_id);
create index reports_reported_user_idx on public.reports (reported_user_id);
create index reports_reporter_idx on public.reports (reporter_id);
create index verification_requests_reviewed_by_idx on public.verification_requests (reviewed_by);
