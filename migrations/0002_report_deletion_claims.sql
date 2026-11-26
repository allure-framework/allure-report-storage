create table if not exists report_deletion_claims (
  report_id text primary key,
  claim_id text not null,
  claimed_at text not null
);

create trigger if not exists reports_delete_cleanup_claim
after delete on reports
begin
  delete from report_deletion_claims where report_id = old.id;
end;
