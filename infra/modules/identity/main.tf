# Identity of the console (M6, ADR 0044 and ADR 0045): one Cognito user pool for the operators, the
# public app client the browser uses, one group per console role, and an identity pool that turns
# the ID token of a signed-in user into temporary AWS credentials for the robot video.
#
# Cognito cannot enforce MFA per group, so TOTP is required for every role (ADR 0044). Each role
# keeps its own IAM role, so that a later Operator-only action is a diff of one policy. Every role
# gets only the viewer actions of Kinesis Video on the robot channels (SEC-ID-3, THREAT_MODEL T8).

locals {
  # One entry per Cognito group. The precedence orders the groups for the ID token claim
  # cognito:preferred_role; the slug names the IAM role of the group.
  console_roles = {
    Admin    = { precedence = 1, slug = "admin" }
    Operator = { precedence = 2, slug = "operator" }
    Viewer   = { precedence = 3, slug = "viewer" }
  }
}

# Operators sign in here; no self sign-up (ADR 0044). Accounts are created by the bootstrap script.
resource "aws_cognito_user_pool" "this" {
  name = "${var.name_prefix}-users"

  # Pool-wide MFA with TOTP only: no SMS, which costs money and can be intercepted (ADR 0044).
  mfa_configuration = "ON"

  software_token_mfa_configuration {
    enabled = true
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 1
  }

  # Recovery is an administrator task: no e-mail or SMS recovery path exists for the operators.
  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }

  # The Essentials tier carries TOTP MFA and groups; advanced security is switched off to keep the
  # demo at the free tier (THREAT_MODEL R3).
  user_pool_tier = "ESSENTIALS"

  user_pool_add_ons {
    advanced_security_mode = "OFF"
  }

  # Off on purpose: make destroy must remove the pool (THREAT_MODEL R49).
  deletion_protection = "INACTIVE"
}

# The public client of the browser: it cannot keep a secret, so there is none. SRP proves the
# password without sending it, and the refresh flow renews the tokens held in memory (ADR 0045).
resource "aws_cognito_user_pool_client" "console" {
  name         = "${var.name_prefix}-console"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  # No USER_PASSWORD_AUTH: the password never leaves the SRP exchange.
  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  # No OAuth flow and no callback URL: there is no hosted UI, so no redirect can be abused.
  allowed_oauth_flows_user_pool_client = false
  supported_identity_providers         = ["COGNITO"]

  access_token_validity  = 15
  id_token_validity      = 15
  refresh_token_validity = 8

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }

  auth_session_validity = 3

  # Sign-out revokes the refresh token, so a stolen one stops working at once.
  enable_token_revocation = true

  # Unknown users and wrong passwords get the same answer, so the console cannot enumerate accounts.
  prevent_user_existence_errors = "ENABLED"
}

# One group per console role. The group role is the IAM role the identity pool assumes for a user
# of that group (role mapping below).
resource "aws_cognito_user_group" "console" {
  for_each = local.console_roles

  name         = each.key
  description  = "Console role ${each.key}."
  user_pool_id = aws_cognito_user_pool.this.id
  precedence   = each.value.precedence
  role_arn     = aws_iam_role.console[each.key].arn
}

# Exchanges the ID token of the user pool for AWS credentials. Unauthenticated access is off, so a
# caller without a signed-in session gets nothing from the pool.
resource "aws_cognito_identity_pool" "this" {
  identity_pool_name               = "${var.name_prefix}-console"
  allow_unauthenticated_identities = false
  allow_classic_flow               = false

  cognito_identity_providers {
    client_id = aws_cognito_user_pool_client.console.id
    # The provider name is the user pool endpoint: cognito-idp.<region>.amazonaws.com/<pool id>.
    provider_name           = aws_cognito_user_pool.this.endpoint
    server_side_token_check = true
  }
}

# The group role is chosen from the cognito:preferred_role claim of the ID token. A user with no
# group gets the authenticated role, which is the Viewer role: the least privilege of the console.
resource "aws_cognito_identity_pool_roles_attachment" "this" {
  identity_pool_id = aws_cognito_identity_pool.this.id

  roles = {
    authenticated = aws_iam_role.console["Viewer"].arn
  }

  role_mapping {
    identity_provider         = "${aws_cognito_user_pool.this.endpoint}:${aws_cognito_user_pool_client.console.id}"
    type                      = "Token"
    ambiguous_role_resolution = "Deny"
  }
}

# Trust of the console roles: only the identity pool may assume them, and only for an
# authenticated identity of this pool (a confused deputy check on the pool id).
data "aws_iam_policy_document" "console_trust" {
  statement {
    sid     = "TrustIdentityPoolAuthenticated"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["cognito-identity.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "cognito-identity.amazonaws.com:aud"
      values   = [aws_cognito_identity_pool.this.id]
    }

    condition {
      test     = "ForAnyValue:StringLike"
      variable = "cognito-identity.amazonaws.com:amr"
      values   = ["authenticated"]
    }
  }
}

# Viewer actions of Kinesis Video on the robot channels only. The channel names follow the robot
# naming of the video stack (ADR 0025), so no other channel of the account is reachable.
data "aws_iam_policy_document" "console_video_viewer" {
  statement {
    sid    = "ViewRobotVideoChannels"
    effect = "Allow"
    actions = [
      "kinesisvideo:DescribeSignalingChannel",
      "kinesisvideo:GetSignalingChannelEndpoint",
      "kinesisvideo:GetIceServerConfig",
      "kinesisvideo:ConnectAsViewer",
    ]
    resources = ["arn:aws:kinesisvideo:${var.region}:${var.account_id}:channel/${var.name_prefix}-*/*"]
  }
}

resource "aws_iam_role" "console" {
  for_each = local.console_roles

  name                 = "${var.name_prefix}-console-${each.value.slug}"
  path                 = var.role_path
  description          = "Identity of the ${each.key} role of the console: viewer actions on the robot video."
  permissions_boundary = var.boundary_arn
  assume_role_policy   = data.aws_iam_policy_document.console_trust.json
}

resource "aws_iam_role_policy" "console_video_viewer" {
  for_each = local.console_roles

  name   = "${var.name_prefix}-console-${each.value.slug}-video"
  role   = aws_iam_role.console[each.key].id
  policy = data.aws_iam_policy_document.console_video_viewer.json
}
