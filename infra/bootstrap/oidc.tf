# Trust between GitHub Actions and AWS. Workflows exchange their short-lived OIDC token for a
# role session, so no long-lived AWS key exists anywhere in the project.

locals {
  # Host without scheme: IAM condition keys are written "<host>:aud" and "<host>:sub".
  github_oidc_host = "token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.github_oidc_host}"
  client_id_list = ["sts.amazonaws.com"]

  # No thumbprint is pinned: AWS validates GitHub's issuer against its own trusted CA library,
  # and a pinned thumbprint would break silently when GitHub rotates its certificate chain.
}
