config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.49.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

# Every provider must tag resources with the four cost-allocation keys (ADR 0023).
rule "aws_provider_missing_default_tags" {
  enabled = true
  tags    = ["project", "env", "component", "owner"]
}
