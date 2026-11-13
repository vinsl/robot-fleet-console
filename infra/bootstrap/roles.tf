# The two CI roles. Each trusts exactly one GitHub subject, so a fork, another branch or a
# reusable workflow cannot assume them. The subject is matched with StringEquals only: a
# StringLike pattern would let a crafted branch name match.
#
# The repository is written in its immutable form (owner@ownerId/repo@repoId), because the
# repository has immutable OIDC subjects enabled: GitHub then puts the numeric ids in the token
# subject instead of the mutable name. A trust on the name would fail every workflow run, and it
# would survive a deleted-and-recreated repository under the same name. The ids are public, not
# secrets (see variables.tf).

locals {
  ci_path = "/mfc-demo-ci/"

  ci_subjects = {
    # Pull requests only: the plan job runs read-only, on any branch of this repository.
    plan = "repo:${var.github_oidc_repository}:pull_request"
    # Only the default branch can deploy (SEC-IAM-1, ADR 0003 for the free-plan fallback).
    deploy = "repo:${var.github_oidc_repository}:ref:refs/heads/main"
    # The same subject as deploy, but a separate role: the e2e job needs no Terraform power, and a
    # widening of the deploy policies never reaches it (ADR 0069, threat R7).
    e2e = "repo:${var.github_oidc_repository}:ref:refs/heads/main"
  }

  ci_assume_role_policy = {
    for role, subject in local.ci_subjects : role => jsonencode({
      Version = "2012-10-17"
      Statement = [
        {
          Sid       = "GitHubOidcAssumeRole"
          Effect    = "Allow"
          Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
          Action    = "sts:AssumeRoleWithWebIdentity"
          Condition = {
            StringEquals = {
              "${local.github_oidc_host}:aud" = "sts.amazonaws.com"
              "${local.github_oidc_host}:sub" = subject
            }
          }
        },
      ]
    })
  }
}

resource "aws_iam_role" "gha_plan" {
  name                 = "mfc-demo-gha-plan"
  path                 = local.ci_path
  max_session_duration = 3600
  assume_role_policy   = local.ci_assume_role_policy.plan
}

resource "aws_iam_role" "gha_deploy" {
  name                 = "mfc-demo-gha-deploy"
  path                 = local.ci_path
  max_session_duration = 3600
  assume_role_policy   = local.ci_assume_role_policy.deploy
}

resource "aws_iam_role" "gha_e2e" {
  name                 = "mfc-demo-gha-e2e"
  path                 = local.ci_path
  max_session_duration = 3600
  assume_role_policy   = local.ci_assume_role_policy.e2e
}

# ReadOnlyAccess is the AWS managed policy for read-only inspection. It gives the plan role
# what `terraform plan` needs to refresh state; the plan guard then removes the reads that
# would expose data to code running in a pull request.
resource "aws_iam_role_policy_attachment" "gha_plan_read_only" {
  role       = aws_iam_role.gha_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "gha_plan_guard" {
  role       = aws_iam_role.gha_plan.name
  policy_arn = aws_iam_policy.plan_guard.arn
}

resource "aws_iam_role_policy_attachment" "gha_deploy_read_only" {
  role       = aws_iam_role.gha_deploy.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "gha_deploy_core" {
  role       = aws_iam_role.gha_deploy.name
  policy_arn = aws_iam_policy.deploy_core.arn
}

resource "aws_iam_role_policy_attachment" "gha_deploy_data" {
  role       = aws_iam_role.gha_deploy.name
  policy_arn = aws_iam_policy.deploy_data.arn
}

resource "aws_iam_role_policy_attachment" "gha_deploy_compute" {
  role       = aws_iam_role.gha_deploy.name
  policy_arn = aws_iam_policy.deploy_compute.arn
}

resource "aws_iam_role_policy_attachment" "gha_deploy_edge" {
  role       = aws_iam_role.gha_deploy.name
  policy_arn = aws_iam_policy.deploy_edge.arn
}

resource "aws_iam_role_policy_attachment" "gha_deploy_iot" {
  role       = aws_iam_role.gha_deploy.name
  policy_arn = aws_iam_policy.deploy_iot.arn
}

# No ReadOnlyAccess here: the e2e job only creates and deletes its ephemeral user and invokes the
# robots function, so read access to table and queue metadata would be unused exposure.
resource "aws_iam_role_policy_attachment" "gha_e2e" {
  role       = aws_iam_role.gha_e2e.name
  policy_arn = aws_iam_policy.e2e.arn
}
