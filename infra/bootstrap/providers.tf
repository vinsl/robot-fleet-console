# AWS provider for the bootstrap root. Credentials come from the environment (SSO profile for
# humans, OIDC for CI); nothing is configured here that could hold a secret.

provider "aws" {
  region = var.region

  # Tags are applied by the provider so that no resource can forget them; the component tag
  # tells bootstrap resources apart from the demo stack when reading Cost Explorer.
  default_tags {
    tags = {
      project   = "mfc"
      env       = "demo"
      component = "bootstrap"
      owner     = var.owner
    }
  }
}
