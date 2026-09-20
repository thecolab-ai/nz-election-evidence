-- Records ONE release gate as open (or closes it again). Anonymous readers receive evidence rows only
-- while BOTH r10_public_surface_review and r8_accountable_legal_entity are open. Opening a gate is a
-- human decision that must point at its evidence (for example the approved REVIEW-REGISTER.md row).
--
--   psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -v gate=r10_public_surface_review \
--        -v evidence="REVIEW-REGISTER.md row dated 2026-..-.., commit <sha>" -v decided_by="Full Name" \
--        -f scripts/db/set_release_gate.sql
--
-- Close (immediately withholds every row from anonymous readers):  add  -v close=1

\if :{?close}
update evidence_private.release_gates
   set state = 'closed', evidence_reference = null, decided_by = null, decided_at = null
 where gate_key = :'gate'
returning gate_key, state;
\else
update evidence_private.release_gates
   set state = 'open', evidence_reference = :'evidence', decided_by = :'decided_by', decided_at = now()
 where gate_key = :'gate' and length(:'evidence') >= 20 and length(:'decided_by') >= 3
returning gate_key, state, decided_at;
\endif

-- Readback exactly as an anonymous reader sees it.
select gate_key, state, public_rows_released from evidence_public.surface_status order by gate_key;
