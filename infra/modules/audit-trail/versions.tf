# Provider and Terraform constraints of the audit-trail module. The module declares no provider
# block: the calling root configures the provider and its default tags.

terraform {
  required_version = ">= 1.17, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}
