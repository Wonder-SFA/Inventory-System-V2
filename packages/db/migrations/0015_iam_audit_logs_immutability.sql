CREATE OR REPLACE FUNCTION iam.prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'iam.audit_logs is append-only; UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_audit_log_mutation ON iam.audit_logs;
CREATE TRIGGER prevent_audit_log_mutation
  BEFORE UPDATE OR DELETE ON iam.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION iam.prevent_audit_log_mutation();
