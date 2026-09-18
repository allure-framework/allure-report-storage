create table if not exists access_tokens (
  id text primary key,
  access_token_hash text not null,
  created_at text not null
);

create unique index if not exists access_tokens_hash_idx
  on access_tokens (access_token_hash);

create table if not exists projects (
  repo text primary key,
  main_branch text not null
);

create table if not exists reports (
  id text primary key,
  repo text not null,
  branch text not null,
  name text,
  status text not null,
  created_at text not null,
  updated_at text not null,
  completed_at text
);

create index if not exists reports_completed_repo_branch_lookup_idx
  on reports (status, repo, branch, completed_at);

create index if not exists reports_completed_repo_branch_id_lookup_idx
  on reports (status, repo, branch, completed_at, id);
