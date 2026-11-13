# Executable security review of the bootstrap root. Each run plans the configuration against a
# mocked AWS provider (no credentials, no AWS call) and asserts one property that a later change
# must not break: a widened trust, a dropped Deny, a policy over the IAM size limit, or a state
# bucket that is no longer private and encrypted in transit.

mock_provider "aws" {}

variables {
  alarm_email = "ops@example.com"

  # The names of infra/bootstrap/terraform.tfvars, so that the size limit is checked on the policy
  # that is deployed: each budget adds one ARN to mfc-demo-deploy-core.
  budget_names = ["3-Euros Alarm", "5-Euros Alarm", "Zero-Spend Alarm"]
}

run "ci_trust_is_limited_to_one_subject_per_role" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_openid_connect_provider.github
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.gha_plan.assume_role_policy).Statement) == 1
    error_message = "plan role trust must contain exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role.gha_plan.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    error_message = "plan role must trust only the GitHub OIDC provider"
  }

  assert {
    condition     = jsondecode(aws_iam_role.gha_plan.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:vinsl@84448605/robot-fleet-console@1439837333:pull_request"
    error_message = "plan role must trust exactly the immutable pull_request subject of this repository"
  }

  assert {
    condition     = jsondecode(aws_iam_role.gha_plan.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "plan role must require the sts.amazonaws.com audience"
  }

  assert {
    condition     = length(keys(jsondecode(aws_iam_role.gha_plan.assume_role_policy).Statement[0].Condition)) == 1
    error_message = "plan role trust must use a single condition operator (StringEquals)"
  }

  assert {
    condition     = try(jsondecode(aws_iam_role.gha_plan.assume_role_policy).Statement[0].Condition.StringLike, null) == null
    error_message = "plan role trust must not use StringLike"
  }

  assert {
    condition     = jsondecode(aws_iam_role.gha_deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:vinsl@84448605/robot-fleet-console@1439837333:ref:refs/heads/main"
    error_message = "deploy role must trust exactly the immutable refs/heads/main subject of this repository"
  }

  assert {
    condition     = jsondecode(aws_iam_role.gha_deploy.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    error_message = "deploy role must trust only the GitHub OIDC provider"
  }

  assert {
    condition     = jsondecode(aws_iam_role.gha_deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "deploy role must require the sts.amazonaws.com audience"
  }

  assert {
    condition     = length(keys(jsondecode(aws_iam_role.gha_deploy.assume_role_policy).Statement[0].Condition)) == 1
    error_message = "deploy role trust must use a single condition operator (StringEquals)"
  }

  assert {
    condition     = try(jsondecode(aws_iam_role.gha_deploy.assume_role_policy).Statement[0].Condition.StringLike, null) == null
    error_message = "deploy role trust must not use StringLike"
  }

  assert {
    condition     = aws_iam_role.gha_plan.max_session_duration == 3600 && aws_iam_role.gha_deploy.max_session_duration == 3600
    error_message = "CI roles must cap sessions at one hour"
  }
}

# The repository identifier is interpolated into the trust subjects, so a value that is not the
# immutable owner@id/repo@id form must fail at validation, before any plan is built.
run "oidc_repository_rejects_mutable_name" {
  command = plan

  variables {
    github_oidc_repository = "vinsl/robot-fleet-console"
  }

  expect_failures = [var.github_oidc_repository]
}

run "oidc_repository_rejects_wildcard" {
  command = plan

  variables {
    github_oidc_repository = "vinsl@84448605/*@1439837333"
  }

  expect_failures = [var.github_oidc_repository]
}

# A colon suffix would turn the subject into a different claim pattern, and a trailing newline
# would survive the trust as an invisible part of the subject. Both must fail validation.
run "oidc_repository_rejects_colon_suffix" {
  command = plan

  variables {
    github_oidc_repository = "vinsl@84448605/robot-fleet-console@1439837333:ref:refs/heads/main"
  }

  expect_failures = [var.github_oidc_repository]
}

run "oidc_repository_rejects_trailing_newline" {
  command = plan

  variables {
    github_oidc_repository = "vinsl@84448605/robot-fleet-console@1439837333\n"
  }

  expect_failures = [var.github_oidc_repository]
}

run "oidc_repository_rejects_missing_repository_id" {
  command = plan

  variables {
    github_oidc_repository = "vinsl@84448605/robot-fleet-console"
  }

  expect_failures = [var.github_oidc_repository]
}

run "customer_managed_policies_stay_safe" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  assert {
    condition = alltrue([
      for p in [
        aws_iam_policy.workload_boundary.policy,
        aws_iam_policy.plan_guard.policy,
        aws_iam_policy.deploy_core.policy,
        aws_iam_policy.deploy_data.policy,
        aws_iam_policy.deploy_compute.policy,
        aws_iam_policy.deploy_edge.policy,
        aws_iam_policy.deploy_iot.policy,
        ] : alltrue([
          for s in jsondecode(p).Statement : s.Effect != "Allow" || !contains(try(s.Action, []), "*")
      ])
    ])
    error_message = "no Allow statement may use the global * action"
  }

  assert {
    condition = alltrue([
      for p in [
        aws_iam_policy.workload_boundary.policy,
        aws_iam_policy.plan_guard.policy,
        aws_iam_policy.deploy_core.policy,
        aws_iam_policy.deploy_data.policy,
        aws_iam_policy.deploy_compute.policy,
        aws_iam_policy.deploy_edge.policy,
        aws_iam_policy.deploy_iot.policy,
      ] : length(p) < 6144
    ])
    error_message = "every customer-managed policy must stay under the 6144-character IAM limit"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.deploy_core.policy).Statement : s.Effect != "Allow" || !contains(try(s.Action, []), "iam:CreateRole") || try(s.Condition.StringEquals["iam:PermissionsBoundary"], "") == "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    ])
    error_message = "every Allow statement granting iam:CreateRole must require the workload boundary"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_core.policy).Statement : s.Effect == "Deny" && contains(flatten([try(s.Resource, [])]), "arn:aws:iam::123456789012:role/mfc-demo-ci/*")
    ])
    error_message = "deploy-core must explicitly deny IAM writes on the CI roles"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_core.policy).Statement : s.Effect == "Deny" && contains(try(s.Action, []), "cloudtrail:StopLogging")
    ])
    error_message = "deploy-core must explicitly deny cloudtrail:StopLogging"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : s.Effect == "Deny" && contains(try(s.Action, []), "iam:*")
    ])
    error_message = "the workload boundary must deny every IAM action"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.plan_guard.policy).Statement : s.Effect == "Deny" && contains(try(s.Action, []), "secretsmanager:GetSecretValue")
    ])
    error_message = "the plan guard must deny secret reads"
  }
}

run "state_bucket_is_private_versioned_and_tls_only" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.state.block_public_acls,
      aws_s3_bucket_public_access_block.state.block_public_policy,
      aws_s3_bucket_public_access_block.state.ignore_public_acls,
      aws_s3_bucket_public_access_block.state.restrict_public_buckets,
    ])
    error_message = "all four S3 Block Public Access settings must be true on the state bucket"
  }

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "state bucket versioning must be Enabled"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_ownership_controls.state.rule : r.object_ownership == "BucketOwnerEnforced"])
    error_message = "state bucket must disable ACLs (BucketOwnerEnforced)"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_server_side_encryption_configuration.state.rule : alltrue([for d in r.apply_server_side_encryption_by_default : d.sse_algorithm == "AES256"])])
    error_message = "state bucket must be encrypted at rest with AES256"
  }

  assert {
    condition     = anytrue([for r in aws_s3_bucket_lifecycle_configuration.state.rule : alltrue([for e in r.noncurrent_version_expiration : e.noncurrent_days == 90])])
    error_message = "noncurrent state versions must expire after 90 days"
  }

  assert {
    condition     = anytrue([for r in aws_s3_bucket_lifecycle_configuration.state.rule : alltrue([for a in r.abort_incomplete_multipart_upload : a.days_after_initiation == 7])])
    error_message = "incomplete multipart uploads must be aborted after 7 days"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s.Effect == "Deny" && try(s.Condition.Bool["aws:SecureTransport"], "") == "false"
    ])
    error_message = "state bucket policy must deny requests that are not TLS"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s.Effect == "Deny" && try(s.Condition.NumericLessThan["s3:TlsVersion"], 0) == 1.2
    ])
    error_message = "state bucket policy must deny TLS versions below 1.2"
  }
}

run "alarm_email_is_a_plain_string_parameter" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  assert {
    condition     = aws_ssm_parameter.alarm_email.name == "/mfc-demo/alarm-email"
    error_message = "the alarm e-mail parameter must live at /mfc-demo/alarm-email"
  }

  assert {
    condition     = aws_ssm_parameter.alarm_email.type == "String"
    error_message = "the alarm e-mail parameter must be a String, not a SecureString (see ssm.tf)"
  }
}

run "audit_trail_and_state_denies_hold" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_core.policy).Statement : s.Effect == "Deny" && contains(try(s.Action, []), "s3:DeleteObjectVersion") && contains(flatten([try(s.Resource, [])]), "arn:aws:s3:::mfc-demo-tfstate-vinsl/*")
    ])
    error_message = "deploy-core must deny s3:DeleteObjectVersion on every state object"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_core.policy).Statement : s.Effect == "Deny" && contains(try(s.Action, []), "cloudtrail:DeleteTrail") && contains(flatten([try(s.Resource, [])]), "*")
    ])
    error_message = "deploy-core must explicitly deny cloudtrail:DeleteTrail"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_core.policy).Statement : s.Effect == "Deny" && contains(try(s.Action, []), "cloudtrail:UpdateTrail") && contains(try(s.Action, []), "cloudtrail:PutEventSelectors")
    ])
    error_message = "deploy-core must explicitly deny cloudtrail:UpdateTrail and cloudtrail:PutEventSelectors"
  }

  assert {
    condition = !anytrue([
      for s in jsondecode(aws_iam_policy.deploy_core.policy).Statement : s.Effect == "Allow" && (contains(try(s.Action, []), "cloudtrail:CreateTrail") || contains(try(s.Action, []), "cloudtrail:DeleteTrail") || contains(try(s.Action, []), "cloudtrail:UpdateTrail") || contains(try(s.Action, []), "cloudtrail:PutEventSelectors"))
    ])
    error_message = "deploy-core must not carry an Allow for a trail change that it denies"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_core.policy).Statement : s.Effect == "Deny" && contains(try(s.Action, []), "access-analyzer:DeleteAnalyzer")
    ])
    error_message = "deploy-core must explicitly deny access-analyzer:DeleteAnalyzer"
  }

  # The state bucket is covered by one Deny in deploy-data, beside the s3:* Allow it carves out of. It
  # is a NotAction, so every bucket action except the reads is refused, including the ones AWS adds
  # later. An exact list of administration actions would let those through, so none is pinned here.
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_data.policy).Statement : try(s.Sid, "") == "DenyStateBucketAdministration" && s.Effect == "Deny" && try(s.Action, null) == null && toset(try(s.NotAction, [])) == toset(["s3:Get*", "s3:List*"]) && toset(flatten([try(s.Resource, [])])) == toset(["arn:aws:s3:::mfc-demo-tfstate-vinsl"])
    ])
    error_message = "deploy-data must deny every action on the state bucket ARN except s3:Get* and s3:List* (NotAction)"
  }

  assert {
    condition = !anytrue([
      for s in jsondecode(aws_iam_policy.deploy_core.policy).Statement : try(s.Sid, "") == "DenyStateBucketAdministration"
    ])
    error_message = "the state bucket deny must live in deploy-data, beside the s3:* Allow, not in deploy-core"
  }
}

# CI keeps the reads that a refresh needs and the tag actions, and loses every other action on the
# trail bucket and its objects, directly and through any workload role it creates (THREAT_MODEL R15).
run "trail_bucket_is_read_only_to_ci" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  # The Sid is pinned and must occur exactly once: a renamed statement, or a second copy of it, fails.
  assert {
    condition = length([for s in jsondecode(aws_iam_policy.deploy_data.policy).Statement : s if try(s.Sid, "") == "DenyTrailBucketChangesExceptTags"]) == 1 && anytrue([
      for s in jsondecode(aws_iam_policy.deploy_data.policy).Statement : try(s.Sid, "") == "DenyTrailBucketChangesExceptTags" && s.Effect == "Deny" && try(s.Action, null) == null && toset(try(s.NotAction, [])) == toset(["s3:Get*", "s3:List*", "s3:PutBucketTagging", "s3:TagResource", "s3:UntagResource"]) && toset(flatten([try(s.Resource, [])])) == toset(["arn:aws:s3:::mfc-demo-trail-*", "arn:aws:s3:::mfc-demo-trail-*/*"])
    ])
    error_message = "deploy-data must hold one DenyTrailBucketChangesExceptTags statement denying every action on the trail bucket and its objects except Get*, List* and the three tag actions"
  }

  # The Sid is pinned and must occur exactly once: a renamed statement, or a second copy of it, fails.
  assert {
    condition = length([for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : s if try(s.Sid, "") == "DenyTrailBucket"]) == 1 && anytrue([
      for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : try(s.Sid, "") == "DenyTrailBucket" && s.Effect == "Deny" && contains(try(s.Action, []), "s3:*") && toset(flatten([try(s.Resource, [])])) == toset(["arn:aws:s3:::mfc-demo-trail-*", "arn:aws:s3:::mfc-demo-trail-*/*"])
    ])
    error_message = "the workload boundary must hold one DenyTrailBucket statement denying every S3 action on the trail bucket and its objects"
  }

  # The two asserts above check that deploy-data and the workload boundary carry their Deny. This one
  # checks that no other policy can reach the trail bucket. An Allow reaches it when one of its Resource
  # patterns matches the bucket ARN or an object ARN and it grants an S3 action (an s3 action, a
  # NotAction or a wildcard service). An Allow with NotResource reaches it whatever its actions are,
  # because NotResource covers every resource except the listed ones. The patterns become anchored
  # regexes: IAM's "*" becomes ".*" and its "?" becomes ".", and the other regex metacharacters are
  # escaped, so "mfc-demo-*" is seen to cover the trail bucket. The two policies that carry the Denies
  # are the only ones allowed to match.
  assert {
    condition = toset([
      for name, p in {
        deploy_core       = aws_iam_policy.deploy_core.policy
        deploy_data       = aws_iam_policy.deploy_data.policy
        deploy_compute    = aws_iam_policy.deploy_compute.policy
        deploy_edge       = aws_iam_policy.deploy_edge.policy
        deploy_iot        = aws_iam_policy.deploy_iot.policy
        workload_boundary = aws_iam_policy.workload_boundary.policy
      } : name
      if anytrue([
        for s in jsondecode(p).Statement : s.Effect == "Allow" && (
          try(s.NotResource, null) != null
          || (
            (try(s.NotAction, null) != null || anytrue([for a in try(s.Action, []) : startswith(a, "s3:") || can(regex("[*]", split(":", a)[0]))]))
            && anytrue([
              for r in flatten([try(s.Resource, [])]) : anytrue([
                for sample in ["arn:aws:s3:::mfc-demo-trail-x", "arn:aws:s3:::mfc-demo-trail-x/y"] : can(regex("^${replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(r, "\\", "\\\\"), ".", "\\."), "+", "\\+"), "?", "."), "(", "\\("), ")", "\\)"), "[", "\\["), "]", "\\]"), "{", "\\{"), "}", "\\}"), "^", "\\^"), "$", "\\$"), "|", "\\|"), "*", ".*")}$", sample))
              ])
            ])
          )
        )
      ])
    ]) == toset(["deploy_data", "workload_boundary"])
    error_message = "only deploy-data and the workload boundary may carry an Allow that reaches the trail bucket or its objects, an Allow with NotResource included"
  }
}

# CI may only restart the logging of the demo trail and tag it; it creates no trail.
run "ci_manages_only_the_demo_trail" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  assert {
    condition = alltrue([
      for p in [
        aws_iam_policy.workload_boundary.policy,
        aws_iam_policy.deploy_core.policy,
        aws_iam_policy.deploy_data.policy,
        aws_iam_policy.deploy_compute.policy,
        aws_iam_policy.deploy_edge.policy,
        aws_iam_policy.deploy_iot.policy,
        ] : alltrue([
          # A NotAction or a wildcard service (*, *:*) grants cloudtrail actions without naming them, so
          # the startswith check below would not see them: they are refused outright.
          for s in jsondecode(p).Statement : s.Effect != "Allow" || (
            alltrue([
              try(s.NotAction, null) == null,
              !anytrue([for a in try(s.Action, []) : can(regex("[*]", split(":", a)[0]))]),
              (!anytrue([for a in try(s.Action, []) : startswith(a, "cloudtrail:")]) || toset(flatten([try(s.Resource, [])])) == toset(["arn:aws:cloudtrail:${var.region}:123456789012:trail/mfc-demo-trail"])),
            ])
          )
      ])
    ])
    error_message = "every Allow statement must name only trail/mfc-demo-trail for cloudtrail actions, and no Allow may use NotAction or a wildcard service"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_core.policy).Statement : s.Effect == "Deny" && contains(try(s.Action, []), "cloudtrail:CreateTrail") && contains(flatten([try(s.Resource, [])]), "*")
    ])
    error_message = "deploy-core must explicitly deny cloudtrail:CreateTrail: CI must not create a second trail or recreate the audit trail"
  }
}

# CIS AWS Foundations 2.1.4 / Security Hub S3.1: account-wide Block Public Access, which CI cannot change.
run "account_blocks_s3_public_access" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  assert {
    condition = alltrue([
      aws_s3_account_public_access_block.this.block_public_acls,
      aws_s3_account_public_access_block.this.block_public_policy,
      aws_s3_account_public_access_block.this.ignore_public_acls,
      aws_s3_account_public_access_block.this.restrict_public_buckets,
    ])
    error_message = "all four account-level S3 Block Public Access settings must be true"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_data.policy).Statement : s.Effect == "Deny" && contains(try(s.Action, []), "s3:PutAccountPublicAccessBlock") && contains(flatten([try(s.Resource, [])]), "*")
    ])
    error_message = "the deploy role must explicitly deny s3:PutAccountPublicAccessBlock, which also authorises the delete"
  }

  # Account-level S3 actions take Resource "*". With no S3 Allow on "*", neither CI nor a workload
  # role can be granted one by a statement that looks scoped.
  assert {
    condition = alltrue([
      for p in [
        aws_iam_policy.workload_boundary.policy,
        aws_iam_policy.deploy_core.policy,
        aws_iam_policy.deploy_data.policy,
        aws_iam_policy.deploy_compute.policy,
        aws_iam_policy.deploy_edge.policy,
        aws_iam_policy.deploy_iot.policy,
        ] : alltrue([
          # A NotAction or a wildcard service (*, *:*) also grants s3 actions, so it is refused whatever its
          # Resource. The s3 check then covers the Allow statements that name an s3 action on Resource *.
          for s in jsondecode(p).Statement : s.Effect != "Allow" || (
            alltrue([
              try(s.NotAction, null) == null,
              !anytrue([for a in try(s.Action, []) : can(regex("[*]", split(":", a)[0]))]),
              (!contains(flatten([try(s.Resource, [])]), "*") || !anytrue([for a in try(s.Action, []) : startswith(a, "s3:")])),
            ])
          )
      ])
    ])
    error_message = "no Allow statement may use NotAction or a wildcard service, and none may grant an s3 action on Resource *"
  }
}

run "plan_guard_denies_partiql_traces_and_audit_reads" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.plan_guard.policy).Statement : s.Effect == "Deny" && contains(try(s.Action, []), "dynamodb:PartiQLSelect")
    ])
    error_message = "the plan guard must deny dynamodb:PartiQLSelect"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.plan_guard.policy).Statement : s.Effect == "Deny" && contains(try(s.Action, []), "cloudtrail:LookupEvents")
    ])
    error_message = "the plan guard must deny cloudtrail:LookupEvents"
  }
}

run "workload_boundary_has_no_global_resource_allow" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  # Only services with no resource-level ARN for these actions may be allowed on every resource.
  # Each entry must say why it is here; add one only with a reason.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : s.Effect != "Allow" || !contains(flatten([try(s.Resource, [])]), "*") || alltrue([
        for a in try(s.Action, []) : contains([
          "xray:*",                       # X-Ray has no resource-level ARN
          "cloudwatch:PutMetricData",     # CloudWatch metrics have no resource-level ARN
          "iot:CreateKeysAndCertificate", # IoT certificate creation has no resource type
        ], a)
      ])
    ])
    error_message = "the workload boundary may allow on Resource * only xray:*, cloudwatch:PutMetricData and iot:CreateKeysAndCertificate"
  }
}

# A topic rule has the IAM resource type "rule". The former "topicrule" ARN matched no resource, so CI
# could not create any rule (ADR 0020, amendment of 2026-11-01).
run "iot_topic_rules_use_the_rule_resource_type" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_iot.policy).Statement : contains(flatten([try(s.Resource, [])]), "arn:aws:iot:${var.region}:123456789012:rule/mfc_demo_*")
    ])
    error_message = "deploy-iot must grant topic rules on arn:aws:iot:<region>:<account>:rule/mfc_demo_*"
  }

  # The whole rendered policy is searched, not only the Resource lists, so that no statement can
  # reintroduce the wrong resource type.
  assert {
    condition     = length(regexall("topicrule", aws_iam_policy.deploy_iot.policy)) == 0
    error_message = "deploy-iot must not mention the topicrule resource type: IAM has no such resource"
  }
}

# IoT certificate ids are generated by AWS, so the certificate actions can only be scoped to cert/*.
# Every Allow statement of the workload boundary is read here, not only the named ones, so that a grant
# added in any statement cannot reach a certificate unnoticed. DeleteCertificate, the transfer and
# registration actions and the iot:Delete* family are never granted: a retired certificate is revoked
# and kept as evidence (THREAT_MODEL R20).
run "boundary_scopes_iot_certificates" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  # The three certificate actions that carry no thing in the request, on cert/* and nothing else.
  assert {
    condition = length([for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : s if try(s.Sid, "") == "WorkloadIotCertificates"]) == 1 && anytrue([
      for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : try(s.Sid, "") == "WorkloadIotCertificates" && s.Effect == "Allow" && length(try(s.Action, [])) == 3 && toset(try(s.Action, [])) == toset([
        "iot:UpdateCertificate",
        "iot:AttachPolicy",
        "iot:DetachPolicy",
      ]) && toset(flatten([try(s.Resource, [])])) == toset(["arn:aws:iot:${var.region}:123456789012:cert/*"])
    ])
    error_message = "the workload boundary must hold one WorkloadIotCertificates Allow with exactly UpdateCertificate, AttachPolicy and DetachPolicy on cert/*"
  }

  # The two actions that take a thing in the request. They are bound to demo things by iot:thingArn:
  # the condition must be exactly that one ArnLike entry, or the binding is lost.
  assert {
    condition = length([for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : s if try(s.Sid, "") == "WorkloadIotThingPrincipals"]) == 1 && anytrue([
      for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : try(s.Sid, "") == "WorkloadIotThingPrincipals" && s.Effect == "Allow" && length(try(s.Action, [])) == 2 && toset(try(s.Action, [])) == toset([
        "iot:AttachThingPrincipal",
        "iot:DetachThingPrincipal",
      ]) && toset(flatten([try(s.Resource, [])])) == toset(["arn:aws:iot:${var.region}:123456789012:cert/*"]) && length(keys(try(s.Condition, {}))) == 1 && length(keys(try(s.Condition.ArnLike, {}))) == 1 && try(s.Condition.ArnLike["iot:thingArn"], "") == "arn:aws:iot:${var.region}:123456789012:thing/mfc-demo-*"
    ])
    error_message = "WorkloadIotThingPrincipals must be one Allow with exactly AttachThingPrincipal and DetachThingPrincipal on cert/*, conditioned only on ArnLike iot:thingArn = arn:aws:iot:<region>:<account>:thing/mfc-demo-*"
  }

  # No Allow outside the two statements above may name a certificate ARN.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : s.Effect != "Allow" || contains(["WorkloadIotCertificates", "WorkloadIotThingPrincipals"], try(s.Sid, "")) || !anytrue([for r in flatten([try(s.Resource, [])]) : strcontains(r, ":cert/")])
    ])
    error_message = "only WorkloadIotCertificates and WorkloadIotThingPrincipals may name a cert/ resource in an Allow"
  }

  # Certificate transfer, registration and deletion, and every iot:Delete* action, are refused in any
  # statement of the boundary, Allow or Deny, present or added later.
  assert {
    condition = !anytrue([
      for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : anytrue([
        for a in flatten([try(s.Action, [])]) : contains(["iot:DeleteCertificate", "iot:TransferCertificate", "iot:AcceptCertificateTransfer", "iot:CreateCertificateFromCsr"], a) || startswith(a, "iot:RegisterCertificate") || startswith(a, "iot:Delete")
      ])
    ])
    error_message = "the workload boundary must never name a certificate transfer, registration or deletion action, nor any iot:Delete* action"
  }

  # NotAction and NotResource in an Allow grant everything except what they list, so they would reach
  # certificates whatever the actions are.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : s.Effect != "Allow" || (try(s.NotAction, null) == null && try(s.NotResource, null) == null)
    ])
    error_message = "no Allow statement of the workload boundary may use NotAction or NotResource"
  }

  # An Allow that grants an IoT action (iot:*, iot:Delete*, or any other) and can reach a certificate must
  # be one of the three reviewed statements, with its exact action set. A resource reaches a certificate
  # when it names cert/, is "*", or is a pattern that matches the certificate ARN of this account. A
  # wildcard service action such as "*" counts as an IoT action here, so it cannot slip past the check.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : s.Effect != "Allow" || !anytrue([
        for a in flatten([try(s.Action, [])]) : startswith(a, "iot:") || can(regex("[*]", split(":", a)[0]))
        ]) || !anytrue([
        for r in flatten([try(s.Resource, [])]) : strcontains(r, ":cert/") || can(regex("^${replace(r, "*", ".*")}$", "arn:aws:iot:${var.region}:123456789012:cert/example"))
        ]) || (try(s.Sid, "") == "WorkloadIotCertificates" && toset(flatten([try(s.Action, [])])) == toset([
          "iot:UpdateCertificate",
          "iot:AttachPolicy",
          "iot:DetachPolicy",
          ])) || (try(s.Sid, "") == "WorkloadIotThingPrincipals" && toset(flatten([try(s.Action, [])])) == toset([
          "iot:AttachThingPrincipal",
          "iot:DetachThingPrincipal",
          ])) || (try(s.Sid, "") == "WorkloadIotCreateCertificate" && toset(flatten([try(s.Action, [])])) == toset([
          "iot:CreateKeysAndCertificate",
      ]))
    ])
    error_message = "an Allow that grants an IoT action and reaches a certificate must be one of WorkloadIotCertificates, WorkloadIotThingPrincipals or WorkloadIotCreateCertificate, with exactly its reviewed actions; no wildcard IoT action may reach a certificate"
  }
}

# Every log group that deploy-core or the workload boundary can write to carries a demo prefix, except
# the IoT V2 logging group, whose name AWS fixes. The two AWSIotLogsV2 ARNs must be present, or IoT
# logging cannot be configured by CI or written by the logging role.
run "iot_log_group_is_the_only_unprefixed_log_group" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  assert {
    condition = alltrue([
      for p in [aws_iam_policy.deploy_core.policy, aws_iam_policy.workload_boundary.policy] : alltrue([
        for s in jsondecode(p).Statement : s.Effect != "Allow" || try(s.Sid, "") == "LogDeliveryForApiAccessLogs" || !anytrue([for a in try(s.Action, []) : startswith(a, "logs:")]) || alltrue([
          for r in flatten([try(s.Resource, [])]) : can(regex("^arn:aws:logs:${var.region}:123456789012:log-group:(/aws/lambda/mfc-demo-|/aws/apigateway/mfc-demo-|/mfc-demo/|AWSIotLogsV2(:|$))", r))
        ])
      ])
    ])
    error_message = "every log resource of deploy-core and the workload boundary must be a demo log group or the AWSIotLogsV2 group"
  }

  # The log delivery actions do not support resource-level permissions, so their statement is the one
  # allowed wildcard; it must stay limited to delivery management and read-only lookups.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.deploy_core.policy).Statement : try(s.Sid, "") != "LogDeliveryForApiAccessLogs" || (
        s.Effect == "Allow" && alltrue([for a in s.Action : contains([
          "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups",
        ], a)])
      )
    ])
    error_message = "the log delivery statement of deploy-core must only hold log delivery management and describe actions"
  }

  assert {
    condition = alltrue([
      for p in [aws_iam_policy.deploy_core.policy, aws_iam_policy.workload_boundary.policy] : alltrue([
        for r in ["arn:aws:logs:${var.region}:123456789012:log-group:AWSIotLogsV2", "arn:aws:logs:${var.region}:123456789012:log-group:AWSIotLogsV2:*"] : contains(flatten([for s in jsondecode(p).Statement : try(s.Resource, [])]), r)
      ])
    ])
    error_message = "deploy-core and the workload boundary must both name the AWSIotLogsV2 log group and its streams"
  }
}

# The e2e role is the only CI role that creates users. Its trust is the main-branch subject, as the
# deploy role's, and its policy is the five statements of the deployed-URL test and nothing else.
run "e2e_role_trusts_only_main_and_holds_five_statements" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target          = aws_iam_openid_connect_provider.github
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  override_resource {
    target          = aws_iam_policy.workload_boundary
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    }
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.gha_e2e.assume_role_policy).Statement) == 1
    error_message = "e2e role trust must contain exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role.gha_e2e.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    error_message = "e2e role must trust only the GitHub OIDC provider"
  }

  assert {
    condition     = jsondecode(aws_iam_role.gha_e2e.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:vinsl@84448605/robot-fleet-console@1439837333:ref:refs/heads/main"
    error_message = "e2e role must trust exactly the main-branch subject of this repository"
  }

  assert {
    condition     = jsondecode(aws_iam_role.gha_e2e.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "e2e role must require the sts.amazonaws.com audience"
  }

  assert {
    condition     = length(keys(jsondecode(aws_iam_role.gha_e2e.assume_role_policy).Statement[0].Condition)) == 1 && try(jsondecode(aws_iam_role.gha_e2e.assume_role_policy).Statement[0].Condition.StringLike, null) == null
    error_message = "e2e role trust must use StringEquals only, never a pattern"
  }

  assert {
    condition     = aws_iam_role.gha_e2e.max_session_duration == 3600 && aws_iam_role.gha_e2e.path == "/mfc-demo-ci/"
    error_message = "e2e role must have a one-hour session and sit on the CI path"
  }

  assert {
    condition     = length(jsondecode(aws_iam_policy.e2e.policy).Statement) == 5
    error_message = "the e2e policy must hold exactly five statements"
  }

  assert {
    condition     = jsondecode(aws_iam_policy.e2e.policy).Statement[0].Sid == "CognitoEphemeralOperator" && jsondecode(aws_iam_policy.e2e.policy).Statement[1].Sid == "InvokeRobotsFunction" && jsondecode(aws_iam_policy.e2e.policy).Statement[2].Sid == "ListEventSourceMappings" && jsondecode(aws_iam_policy.e2e.policy).Statement[3].Sid == "GetEventSourceMappings" && jsondecode(aws_iam_policy.e2e.policy).Statement[4].Sid == "UpdateIngestConsumerEventSourceMapping"
    error_message = "the e2e policy statements must be CognitoEphemeralOperator, InvokeRobotsFunction, ListEventSourceMappings, GetEventSourceMappings then UpdateIngestConsumerEventSourceMapping"
  }

  # Only the list statement may name *: IAM has no resource for that action (see its comment in policies.tf).
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.e2e.policy).Statement : s.Effect == "Allow" && (s.Sid == "ListEventSourceMappings" || !contains(flatten([try(s.Resource, [])]), "*"))])
    error_message = "the e2e policy must allow only explicit resources, except the list statement, never Resource * elsewhere"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.e2e.policy).Statement : alltrue([for a in s.Action : a != "*" && !endswith(a, ":*")])])
    error_message = "the e2e policy must not use a wildcard action"
  }

  assert {
    condition     = toset(jsondecode(aws_iam_policy.e2e.policy).Statement[0].Action) == toset(["cognito-idp:AdminCreateUser", "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminDeleteUser", "cognito-idp:ListUsers"])
    error_message = "the Cognito statement must hold exactly the four user actions of the ephemeral operator"
  }

  assert {
    condition     = toset(jsondecode(aws_iam_policy.e2e.policy).Statement[0].Resource) == toset(["arn:aws:cognito-idp:${var.region}:123456789012:userpool/*"]) && jsondecode(aws_iam_policy.e2e.policy).Statement[0].Condition.StringEquals["aws:ResourceTag/project"] == "mfc"
    error_message = "the Cognito statement must be limited to user pools tagged project=mfc"
  }

  assert {
    condition     = toset(jsondecode(aws_iam_policy.e2e.policy).Statement[1].Action) == toset(["lambda:InvokeFunction"]) && toset(jsondecode(aws_iam_policy.e2e.policy).Statement[1].Resource) == toset(["arn:aws:lambda:${var.region}:123456789012:function:mfc-demo-robots"])
    error_message = "the invoke statement must allow lambda:InvokeFunction on the exact mfc-demo-robots function only"
  }

  assert {
    condition     = toset(jsondecode(aws_iam_policy.e2e.policy).Statement[2].Action) == toset(["lambda:ListEventSourceMappings"]) && toset(flatten([try(jsondecode(aws_iam_policy.e2e.policy).Statement[2].Resource, [])])) == toset(["*"]) && try(jsondecode(aws_iam_policy.e2e.policy).Statement[2].Condition, null) == null
    error_message = "the list statement must allow lambda:ListEventSourceMappings on * with no condition, as IAM has no resource for it"
  }

  # The read carries no condition: it grants no change, and the write below is the only scoped grant.
  assert {
    condition     = toset(jsondecode(aws_iam_policy.e2e.policy).Statement[3].Action) == toset(["lambda:GetEventSourceMapping"]) && toset(flatten([try(jsondecode(aws_iam_policy.e2e.policy).Statement[3].Resource, [])])) == toset(["arn:aws:lambda:${var.region}:123456789012:event-source-mapping:*"]) && try(jsondecode(aws_iam_policy.e2e.policy).Statement[3].Condition, null) == null
    error_message = "the get statement must allow only lambda:GetEventSourceMapping on the event source mappings, with no condition"
  }

  assert {
    condition     = toset(jsondecode(aws_iam_policy.e2e.policy).Statement[4].Action) == toset(["lambda:UpdateEventSourceMapping"]) && toset(flatten([try(jsondecode(aws_iam_policy.e2e.policy).Statement[4].Resource, [])])) == toset(["arn:aws:lambda:${var.region}:123456789012:event-source-mapping:*"])
    error_message = "the update statement must allow only lambda:UpdateEventSourceMapping on the event source mappings, never a wildcard"
  }

  assert {
    condition     = length(keys(jsondecode(aws_iam_policy.e2e.policy).Statement[4].Condition)) == 1 && length(keys(jsondecode(aws_iam_policy.e2e.policy).Statement[4].Condition.ArnEquals)) == 1 && jsondecode(aws_iam_policy.e2e.policy).Statement[4].Condition.ArnEquals["lambda:FunctionArn"] == "arn:aws:lambda:${var.region}:123456789012:function:mfc-demo-ingest-telemetry"
    error_message = "the update statement must be bound by ArnEquals lambda:FunctionArn to the ingest-telemetry function only"
  }

  # No lambda wildcard and no PassRole in any statement: the role can never pass a role to a function or change one.
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.e2e.policy).Statement : alltrue([for a in s.Action : a != "lambda:*" && a != "iam:PassRole"])])
    error_message = "the e2e policy must hold no lambda:* action and no iam:PassRole"
  }

  # Resource * is allowed only for the list statement, which IAM cannot scope.
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.e2e.policy).Statement : s.Sid == "ListEventSourceMappings" || !contains(flatten([try(s.Resource, [])]), "*")])
    error_message = "the e2e policy may name Resource * only in ListEventSourceMappings"
  }

  assert {
    condition     = length(aws_iam_policy.e2e.policy) < 6144
    error_message = "the e2e policy must stay under the 6144-character IAM limit"
  }
}
