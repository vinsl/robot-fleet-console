# Credentials come from the environment (IAM Identity Center locally, OIDC in CI), never from
# this file. Tags are applied by the provider so that no resource can forget them.

provider "aws" {
  region = var.region

  default_tags {
    tags = local.default_tags
  }
}
