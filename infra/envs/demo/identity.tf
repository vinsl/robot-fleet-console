# Identity of the console (M6, ADR 0044): the operator user pool, the console app client, the
# groups that map to the console roles, and the identity pool that gives the video viewer its
# credentials. The roles carry the workload boundary and path, as every workload role does (ADR 0020).

module "identity" {
  source = "../../modules/identity"

  name_prefix  = local.name_prefix
  region       = var.region
  account_id   = local.account_id
  boundary_arn = local.workload_boundary_arn
  role_path    = local.workload_role_path
}
