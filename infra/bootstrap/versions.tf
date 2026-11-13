# Bootstrap root: the Terraform state bucket, the GitHub OIDC provider, the CI roles and the
# permission boundary that every workload role must carry. It is applied by the owner from an SSO
# session, never by CI (the CI roles are defined here, so they cannot be allowed to change them).
#
# Chicken-and-egg: the state of this root lives in the bucket it creates. The first apply runs
# with a local state, through a git-ignored `override.tf` containing `backend "local" {}`
# (`init -backend=false` is not enough, `plan` still asks for the S3 backend), then
# `terraform init -migrate-state` moves the state into the bucket once `override.tf` is removed. The backend block cannot take variables, so the bucket name
# and region are literals here and must match variables.tf defaults.

terraform {
  required_version = ">= 1.17, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }

  backend "s3" {
    bucket       = "mfc-demo-tfstate-vinsl"
    key          = "bootstrap/terraform.tfstate"
    region       = "eu-west-3"
    use_lockfile = true # S3 native locking (ADR 0005): no DynamoDB table to pay for or to protect
    encrypt      = true
  }
}
