# Account-wide S3 Block Public Access (CIS AWS Foundations v3.0.0 and v5.0.0 control 2.1.4, Security
# Hub control S3.1). Every bucket of the project already blocks public access on its own; the
# account-level setting also covers buckets created later, and a bucket-level setting cannot loosen
# it. The deploy role is denied s3:PutAccountPublicAccessBlock (policies.tf, ADR 0024).
resource "aws_s3_account_public_access_block" "this" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  # A destroy calls DeletePublicAccessBlock, which turns the setting off for every bucket of the
  # account. Removing the guard is a deliberate, reviewed change. prevent_destroy does not protect
  # against deleting this resource block: to stop managing the setting without changing it, replace
  # the block with a removed block (Terraform 1.7 and later):
  #
  #   removed {
  #     from = aws_s3_account_public_access_block.this
  #     lifecycle {
  #       destroy = false
  #     }
  #   }
  lifecycle {
    prevent_destroy = true
  }
}
