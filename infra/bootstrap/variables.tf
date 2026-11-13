# Inputs of the bootstrap root. The values are not secret except alarm_email, which is marked
# sensitive so that it never appears in plan output or CI logs.

variable "region" {
  type        = string
  description = "AWS region of the demo account. Limited to the two regions the demo may use."
  default     = "eu-west-3"

  validation {
    condition     = contains(["eu-west-3", "eu-west-1"], var.region)
    error_message = "region must be eu-west-3 or eu-west-1."
  }
}

variable "owner" {
  type        = string
  description = "Value of the owner tag applied to every bootstrap resource."
  default     = "vincent"
}

variable "github_oidc_repository" {
  type        = string
  description = "Repository as written in GitHub's immutable OIDC subject (owner@ownerId/repo@repoId), which the CI role trust conditions match. Read it with `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`."
  default     = "vinsl@84448605/robot-fleet-console@1439837333"

  # The value is interpolated into IAM trust conditions. The format check guards against wildcards,
  # extra segments and malformed values, which would widen or break the trust. It does not guard
  # against a wrong id: the default value is the only authority, and a wrong but well-formed id
  # would pass validation and fail every CI run.
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+@[0-9]+/[A-Za-z0-9_.-]+@[0-9]+$", var.github_oidc_repository))
    error_message = "github_oidc_repository must be of the form owner@ownerId/repo@repoId, for example vinsl@84448605/robot-fleet-console@1439837333 (the immutable OIDC subject of the repository)."
  }
}

variable "state_bucket_name" {
  type        = string
  description = "Name of the S3 bucket that holds every Terraform state of the project."
  default     = "mfc-demo-tfstate-vinsl"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be a valid lowercase S3 bucket name."
  }
}

variable "alarm_email" {
  type        = string
  description = "E-mail address subscribed to the alarm topic and stored in SSM. Not a secret, but kept out of logs."
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be a valid e-mail address."
  }
}

variable "budget_names" {
  type        = list(string)
  description = "Names of the AWS Budgets created by the demo stack. The CI deploy role may only manage these budgets."

  # An empty list would produce an IAM statement without resources, which IAM rejects; the
  # validation fails earlier and with a clear message.
  validation {
    condition     = length(var.budget_names) > 0
    error_message = "budget_names must list at least one budget."
  }
}
