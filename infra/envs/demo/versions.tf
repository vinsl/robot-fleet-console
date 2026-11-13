# Demo environment root: pins Terraform and the AWS provider. The backend literals must match
# infra/bootstrap because a backend block cannot take variables. The bucket literal below and the
# bucket_suffix default in variables.tf must change together. The lock object
# envs/demo/terraform.tfstate.tflock is the one the mfc-demo-deploy-core policy allows (ADR 0005).

terraform {
  required_version = ">= 1.17, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
    # Packs the bundles of services/api into the Lambda deployment archives (ADR 0021).
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.8, < 3.0"
    }
  }

  backend "s3" {
    bucket       = "mfc-demo-tfstate-vinsl"
    key          = "envs/demo/terraform.tfstate"
    region       = "eu-west-3"
    use_lockfile = true # S3 native locking (ADR 0005)
    encrypt      = true
  }
}
