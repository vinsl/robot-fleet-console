# Alarm recipient, read by the demo stack at deploy time so that the address is not hard-coded.

resource "aws_ssm_parameter" "alarm_email" {
  #checkov:skip=CKV2_AWS_34:String by design, see the comment on the type below: the alarm address is not a credential, and SecureString needs a customer-managed KMS key (SPEC section 11).
  name = "/mfc-demo/alarm-email"

  # String rather than SecureString: the address is not a credential, and SecureString would
  # need a customer-managed KMS key, which SPEC section 11 excludes for cost. The plan guard
  # keeps the CI plan role allowed to read this one parameter only.
  type  = "String"
  value = var.alarm_email
}
