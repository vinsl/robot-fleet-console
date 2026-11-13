# Demo environment root: shared lookups and the naming constants that every CI policy and the
# workload boundary match (ADR 0020). Resources live in budgets.tf and in the modules.

data "aws_caller_identity" "current" {}

# Account-specific IoT endpoints: the robots function and the robot kits receive them, so that no
# endpoint literal is committed (engineering standards: no hard-coded account or region).
data "aws_iot_endpoint" "data" {
  endpoint_type = "iot:Data-ATS"
}

data "aws_iot_endpoint" "credentials" {
  endpoint_type = "iot:CredentialProvider"
}

# The alarm address lives in SSM (infra/bootstrap/ssm.tf) so that no committed file holds it.
# The data source marks the value sensitive: plans and logs show "(sensitive value)".
data "aws_ssm_parameter" "alarm_email" {
  name = local.alarm_email_parameter
}

locals {
  # Constant on purpose: every CI policy and the workload boundary match this prefix (ADR 0020).
  name_prefix           = "mfc-demo"
  alarm_email_parameter = "/mfc-demo/alarm-email"
  account_id            = data.aws_caller_identity.current.account_id
  alarm_email           = data.aws_ssm_parameter.alarm_email.value

  # The four cost-allocation keys of ADR 0023. The provider applies them, and the robots function
  # receives the same map as RESOURCE_TAGS, which its env schema checks.
  default_tags = {
    project   = "mfc"
    env       = "demo"
    component = "foundation"
    owner     = var.owner
  }

  # Built from the boundary name of infra/bootstrap (roles.tf, policies.tf): every workload role
  # carries this boundary and this path, which the deploy role may create and pass (ADR 0020).
  workload_boundary_arn = "arn:aws:iam::${local.account_id}:policy/mfc-demo-ci/mfc-demo-workload-boundary"
  workload_role_path    = "/mfc-demo/"

  # Bundles built by `pnpm build` in services/api; the deploy workflow builds them before the plan.
  api_dist_dir = "${path.root}/../../../services/api/dist"
}

module "audit_trail" {
  source        = "../../modules/audit-trail"
  name_prefix   = local.name_prefix
  bucket_suffix = var.bucket_suffix
  account_id    = local.account_id
  region        = var.region
}

module "alarm_topic" {
  source      = "../../modules/alarm-topic"
  name_prefix = local.name_prefix
  account_id  = local.account_id
  region      = var.region
  alarm_email = local.alarm_email
}
