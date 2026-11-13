# Provider and Terraform constraints of the lambda-function module. The module declares no provider
# block: the calling root configures the provider and its default tags. The archive provider packs
# the bundle built by services/api.

terraform {
  required_version = ">= 1.17, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.8, < 3.0"
    }
  }
}
