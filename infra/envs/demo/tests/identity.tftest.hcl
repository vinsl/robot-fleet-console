# Executable checks of the identity module (M6, ADR 0044 and ADR 0045): TOTP MFA on for every role,
# admin-only sign-up, the public app client without secret or password flow, the token lifetimes,
# the identity pool without unauthenticated access, the group to role mapping, the boundary and
# path of the console roles, and the viewer-only Kinesis Video policy of every console role.
#
# Known gap: the trust policy of the console roles (the pool audience and the authenticated amr
# condition) is built from the pool id. A data source that depends on a pool id is not known in a
# plan: asserting on aws_iam_role.console[*].assume_role_policy fails with "Condition expression
# could not be evaluated at this time" (tried 2026-11-03). The trust is reviewed in
# the plan comment of the deploy workflow (THREAT_MODEL R50).
#
# The provider is configured without credentials and every skip flag is set, so the plan makes no
# AWS call. The policy documents are data sources built locally, so the video policy JSON is
# readable in the plan, which a mocked provider would not give. The ids that AWS generates are fixed
# with override_resource so that the attributes are known at plan time.

provider "aws" {
  region                      = "eu-west-3"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

variables {
  name_prefix  = "mfc-demo"
  region       = "eu-west-3"
  account_id   = "123456789012"
  boundary_arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
  role_path    = "/mfc-demo/"
}

override_resource {
  target          = aws_cognito_user_pool.this
  override_during = plan
  values = {
    id       = "eu-west-3_A1b2C3d4E"
    arn      = "arn:aws:cognito-idp:eu-west-3:123456789012:userpool/eu-west-3_A1b2C3d4E"
    endpoint = "cognito-idp.eu-west-3.amazonaws.com/eu-west-3_A1b2C3d4E"
  }
}

override_resource {
  target          = aws_cognito_user_pool_client.console
  override_during = plan
  values          = { id = "5g6h7i8j9k0l1m2n3o4p5q6r7s" }
}

override_resource {
  target          = aws_cognito_identity_pool.this
  override_during = plan
  values          = { id = "eu-west-3:11111111-2222-3333-4444-555555555555" }
}

# The IAM role ARNs are known only after apply: fixed here so that the group and the attachment can
# be compared with the roles in the plan.
override_resource {
  target          = aws_iam_role.console["Admin"]
  override_during = plan
  values          = { arn = "arn:aws:iam::123456789012:role/mfc-demo/mfc-demo-console-admin" }
}

override_resource {
  target          = aws_iam_role.console["Operator"]
  override_during = plan
  values          = { arn = "arn:aws:iam::123456789012:role/mfc-demo/mfc-demo-console-operator" }
}

override_resource {
  target          = aws_iam_role.console["Viewer"]
  override_during = plan
  values          = { arn = "arn:aws:iam::123456789012:role/mfc-demo/mfc-demo-console-viewer" }
}

run "user_pool_requires_totp_and_admin_created_accounts" {
  command = plan

  module {
    source = "../../modules/identity"
  }

  assert {
    condition     = aws_cognito_user_pool.this.mfa_configuration == "ON" && aws_cognito_user_pool.this.software_token_mfa_configuration[0].enabled
    error_message = "MFA must be ON with the software token (TOTP) for every role, since Cognito cannot enforce it per group (ADR 0044)"
  }

  assert {
    condition     = aws_cognito_user_pool.this.admin_create_user_config[0].allow_admin_create_user_only
    error_message = "self sign-up must be off: accounts are created by the bootstrap script only"
  }

  assert {
    condition     = contains(aws_cognito_user_pool.this.username_attributes, "email")
    error_message = "the operators sign in with their e-mail address"
  }

  assert {
    condition     = aws_cognito_user_pool.this.password_policy[0].minimum_length >= 12 && aws_cognito_user_pool.this.password_policy[0].temporary_password_validity_days == 1
    error_message = "the password policy needs at least 12 characters and a one-day temporary password"
  }

  assert {
    condition     = [for m in aws_cognito_user_pool.this.account_recovery_setting[0].recovery_mechanism : m.name] == ["admin_only"]
    error_message = "account recovery must be administrator-only"
  }

  assert {
    condition     = aws_cognito_user_pool.this.user_pool_tier == "ESSENTIALS" && aws_cognito_user_pool.this.user_pool_add_ons[0].advanced_security_mode == "OFF"
    error_message = "the pool runs on the Essentials tier with advanced security off (THREAT_MODEL R3)"
  }

  assert {
    condition     = aws_cognito_user_pool.this.deletion_protection == "INACTIVE"
    error_message = "deletion protection must stay off so that make destroy removes the pool (THREAT_MODEL R49)"
  }
}

run "app_client_is_public_srp_only_with_short_tokens" {
  command = plan

  module {
    source = "../../modules/identity"
  }

  assert {
    condition     = !aws_cognito_user_pool_client.console.generate_secret
    error_message = "the browser client must not have a secret"
  }

  assert {
    condition     = toset(aws_cognito_user_pool_client.console.explicit_auth_flows) == toset(["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"])
    error_message = "only SRP and the refresh flow are allowed: USER_PASSWORD_AUTH would send the password to Cognito"
  }

  assert {
    condition     = !aws_cognito_user_pool_client.console.allowed_oauth_flows_user_pool_client && length(aws_cognito_user_pool_client.console.callback_urls) == 0
    error_message = "the client has no OAuth flow and no callback URL: there is no hosted UI to abuse"
  }

  assert {
    condition     = aws_cognito_user_pool_client.console.access_token_validity == 15 && aws_cognito_user_pool_client.console.id_token_validity == 15 && aws_cognito_user_pool_client.console.refresh_token_validity == 8
    error_message = "tokens last 15 minutes (access and ID) and 8 hours (refresh)"
  }

  assert {
    condition     = aws_cognito_user_pool_client.console.token_validity_units[0].access_token == "minutes" && aws_cognito_user_pool_client.console.token_validity_units[0].refresh_token == "hours"
    error_message = "the token validity units must be minutes for access and ID, and hours for refresh"
  }

  assert {
    condition     = aws_cognito_user_pool_client.console.enable_token_revocation && aws_cognito_user_pool_client.console.prevent_user_existence_errors == "ENABLED"
    error_message = "token revocation must be on, and unknown users must get the same answer as wrong passwords"
  }
}

run "identity_pool_has_no_unauthenticated_access_and_checks_the_token" {
  command = plan

  module {
    source = "../../modules/identity"
  }

  assert {
    condition     = !aws_cognito_identity_pool.this.allow_unauthenticated_identities && !aws_cognito_identity_pool.this.allow_classic_flow
    error_message = "the identity pool must not hand out credentials to unauthenticated callers"
  }

  assert {
    condition     = [for p in aws_cognito_identity_pool.this.cognito_identity_providers : p.server_side_token_check] == [true] && [for p in aws_cognito_identity_pool.this.cognito_identity_providers : p.client_id] == ["5g6h7i8j9k0l1m2n3o4p5q6r7s"]
    error_message = "the identity pool must check the token server side and accept only the console client"
  }

  assert {
    condition     = [for m in aws_cognito_identity_pool_roles_attachment.this.role_mapping : m.type] == ["Token"] && [for m in aws_cognito_identity_pool_roles_attachment.this.role_mapping : m.ambiguous_role_resolution] == ["Deny"]
    error_message = "the role mapping must use the token claim and deny an ambiguous choice"
  }

  assert {
    condition     = [for m in aws_cognito_identity_pool_roles_attachment.this.role_mapping : m.identity_provider] == ["cognito-idp.eu-west-3.amazonaws.com/eu-west-3_A1b2C3d4E:5g6h7i8j9k0l1m2n3o4p5q6r7s"]
    error_message = "the identity provider of the mapping must be the user pool endpoint and the console client"
  }
}

run "groups_map_each_role_to_its_iam_role_in_precedence_order" {
  command = plan

  module {
    source = "../../modules/identity"
  }

  assert {
    condition     = aws_cognito_user_group.console["Admin"].precedence == 1 && aws_cognito_user_group.console["Operator"].precedence == 2 && aws_cognito_user_group.console["Viewer"].precedence == 3
    error_message = "the groups must be Admin, Operator and Viewer, in that precedence order"
  }

  assert {
    condition     = aws_cognito_user_group.console["Admin"].role_arn == aws_iam_role.console["Admin"].arn && aws_cognito_user_group.console["Operator"].role_arn == aws_iam_role.console["Operator"].arn && aws_cognito_user_group.console["Viewer"].role_arn == aws_iam_role.console["Viewer"].arn
    error_message = "each group must carry the IAM role of its own console role"
  }

  assert {
    condition     = aws_cognito_identity_pool_roles_attachment.this.roles["authenticated"] == aws_iam_role.console["Viewer"].arn
    error_message = "the authenticated fallback must be the Viewer role, the least privileged one"
  }
}

run "console_roles_are_bounded_and_pathed" {
  command = plan

  module {
    source = "../../modules/identity"
  }

  assert {
    condition     = alltrue([for r in aws_iam_role.console : r.permissions_boundary == "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary" && r.path == "/mfc-demo/"])
    error_message = "every console role must carry the workload boundary and the /mfc-demo/ path"
  }

  assert {
    condition     = aws_iam_role.console["Admin"].name == "mfc-demo-console-admin" && aws_iam_role.console["Operator"].name == "mfc-demo-console-operator" && aws_iam_role.console["Viewer"].name == "mfc-demo-console-viewer"
    error_message = "the console roles are named mfc-demo-console-<role>"
  }
}

run "every_console_role_has_only_the_viewer_video_actions_on_robot_channels" {
  command = plan

  module {
    source = "../../modules/identity"
  }

  assert {
    condition     = alltrue([for r in ["Admin", "Operator", "Viewer"] : toset(jsondecode(aws_iam_role_policy.console_video_viewer[r].policy).Statement[0].Action) == toset(["kinesisvideo:DescribeSignalingChannel", "kinesisvideo:GetSignalingChannelEndpoint", "kinesisvideo:GetIceServerConfig", "kinesisvideo:ConnectAsViewer"])])
    error_message = "every console role gets the four viewer actions and nothing else (SEC-ID-3)"
  }

  assert {
    condition     = alltrue([for r in ["Admin", "Operator", "Viewer"] : [for x in flatten([jsondecode(aws_iam_role_policy.console_video_viewer[r].policy).Statement[0].Resource]) : x] == ["arn:aws:kinesisvideo:eu-west-3:123456789012:channel/mfc-demo-*/*"]])
    error_message = "the video actions are scoped to the robot channels of the demo, never to *"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.console_video_viewer["Viewer"].policy).Statement) == 1
    error_message = "the video policy holds one statement"
  }
}

run "identity_outputs_are_the_issuer_and_the_ids_only" {
  command = plan

  module {
    source = "../../modules/identity"
  }

  assert {
    condition     = output.user_pool_endpoint == "https://cognito-idp.eu-west-3.amazonaws.com/eu-west-3_A1b2C3d4E"
    error_message = "the issuer is the https form of the user pool endpoint"
  }

  assert {
    condition     = output.user_pool_client_id == "5g6h7i8j9k0l1m2n3o4p5q6r7s" && output.identity_pool_id == "eu-west-3:11111111-2222-3333-4444-555555555555"
    error_message = "the client id and the identity pool id are passed through unchanged"
  }
}
