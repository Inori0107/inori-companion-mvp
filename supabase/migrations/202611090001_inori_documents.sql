-- Only the server accesses this table. Every authenticated route derives its key
-- from the verified Supabase Auth user ID. Revisions make writes atomic across instances.
create table public.inori_documents (
  key text primary key check (
    key ~ '^u-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or key = 'persona'
  ),
  revision integer not null check (revision > 0),
  data jsonb not null check (jsonb_typeof(data) = 'object')
);
alter table public.inori_documents enable row level security;
revoke all on table public.inori_documents from public, anon, authenticated;
grant select, insert, update, delete on table public.inori_documents to service_role;
create unique index inori_widget_hash
  on public.inori_documents ((data->>'widgetHash'))
  where data->>'widgetHash' is not null;
