-- Existing Supabase project only. Provision the per-server access-token hash
-- and encrypted initial envelope separately, never commit live values here.
create schema if not exists bankmcp_private;
revoke all on schema bankmcp_private from public, anon, authenticated;
create table if not exists bankmcp_private.state (
  access_hash text primary key check (access_hash ~ '^[a-f0-9]{64}$'),
  revision bigint not null check (revision > 0),
  envelope text not null check (length(envelope) between 48 and 3000000),
  operation_id uuid not null,
  updated_at timestamptz not null default now()
);
create table if not exists bankmcp_private.commits (
  access_hash text not null references bankmcp_private.state(access_hash),
  operation_id uuid not null,
  revision bigint not null,
  envelope text not null,
  created_at timestamptz not null default now(),
  primary key (access_hash, operation_id),
  unique (access_hash, revision)
);
alter table bankmcp_private.state enable row level security;
alter table bankmcp_private.commits enable row level security;
revoke all on all tables in schema bankmcp_private from public, anon, authenticated;

create or replace function public.bankmcp_state_read(p_access_token text, p_operation_id uuid default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare h text; r bankmcp_private.state%rowtype; c bankmcp_private.commits%rowtype;
begin
  if p_access_token is null or length(p_access_token) < 40 then raise sqlstate 'PT403' using message='State access denied'; end if;
  h := encode(extensions.digest(p_access_token, 'sha256'), 'hex');
  select * into r from bankmcp_private.state where access_hash = h;
  if not found then raise sqlstate 'PT403' using message='State access denied'; end if;
  if p_operation_id is not null then
    select * into c from bankmcp_private.commits where access_hash=h and operation_id=p_operation_id;
    if found then return jsonb_build_object('revision',c.revision,'envelope',c.envelope,'operation_id',c.operation_id,'matched_operation',true); end if;
  end if;
  return jsonb_build_object('revision',r.revision,'envelope',r.envelope,'operation_id',r.operation_id,'matched_operation',false);
end $$;

create or replace function public.bankmcp_state_commit(p_access_token text, p_expected bigint, p_envelope text, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare h text; r bankmcp_private.state%rowtype; c bankmcp_private.commits%rowtype;
begin
  if p_access_token is null or length(p_access_token) < 40 then raise sqlstate 'PT403' using message='State access denied'; end if;
  h := encode(extensions.digest(p_access_token, 'sha256'), 'hex');
  select * into r from bankmcp_private.state where access_hash=h for update;
  if not found then raise sqlstate 'PT403' using message='State access denied'; end if;
  if p_operation_id is null or p_envelope is null or length(p_envelope) not between 48 and 3000000 then raise sqlstate 'PT400' using message='Invalid state request'; end if;
  select * into c from bankmcp_private.commits where access_hash=h and operation_id=p_operation_id;
  if found then
    if c.envelope <> p_envelope then raise sqlstate 'PT409' using message='Operation identity mismatch'; end if;
    return jsonb_build_object('revision',c.revision,'envelope',c.envelope,'operation_id',c.operation_id);
  end if;
  if r.revision <> p_expected then raise sqlstate 'PT409' using message='State revision conflict'; end if;
  insert into bankmcp_private.commits(access_hash,operation_id,revision,envelope) values(h,p_operation_id,r.revision+1,p_envelope);
  update bankmcp_private.state set revision=r.revision+1,envelope=p_envelope,operation_id=p_operation_id,updated_at=now() where access_hash=h;
  return jsonb_build_object('revision',r.revision+1,'envelope',p_envelope,'operation_id',p_operation_id);
end $$;
revoke all on function public.bankmcp_state_read(text,uuid) from public, anon, authenticated;
revoke all on function public.bankmcp_state_commit(text,bigint,text,uuid) from public, anon, authenticated;
grant execute on function public.bankmcp_state_read(text,uuid) to anon;
grant execute on function public.bankmcp_state_commit(text,bigint,text,uuid) to anon;
