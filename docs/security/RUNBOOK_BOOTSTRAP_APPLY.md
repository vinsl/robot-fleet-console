# Runbook: apply a bootstrap change and verify it

Procedure written for bootstrap PR C (ADR 0024) and reused for every later change to `infra/bootstrap` (the IoT grants of
PR #22 were applied with it).
The bootstrap is applied by the owner from an SSO session, never by CI. Never print account ids or the alarm
address; the commands below mask them. Plan and apply output contain policy ARNs with the account id: do not paste
them anywhere without masking. Saved plan files hold the alarm address in clear text (THREAT_MODEL R17): write them
to a temporary mode 0600 file and delete them after the apply.

PR C changes only comments in `infra/modules/audit-trail`, so it needs no `-target` apply (ADR 0024).

Values quoted as "expected" (plan counts, resource names, simulated decisions) are those of PR C. Each bootstrap PR
states its own expected plan in its description, and that one prevails: the IoT grants of PR #22 gave `0 to add, 3 to
change, 0 to destroy` (`workload_boundary`, `deploy_core`, `deploy_iot`, attribute `policy` only).

## Apply sequence (from the owner's SSO session) and rollback

Order: PR review (reviewer + security-reviewer) → **the owner merges** → wait for the deploy triggered by the merge (old policies,
expected no-op + smoke green) → the owner applies the bootstrap → dispatch the deploy (new policies, expected no-op) → V1, V2, V4.
Never apply the bootstrap while a deploy is running: an IAM policy version swapped in the middle of an apply can cause a
transient AccessDenied.

1. Prepare the plan. Replace `<reviewed-sha>` with the commit SHA recorded in the PR. A non-zero exit from the `git diff`
   means that `infra/bootstrap` on main differs from the reviewed commit: stop and report.

   ```bash
   aws sso login --profile mfc && export AWS_PROFILE=mfc
   git switch main && git pull --ff-only
   git diff --exit-code <reviewed-sha> HEAD -- infra/bootstrap
   cd infra/bootstrap && terraform init -input=false
   export TF_VAR_alarm_email="$(aws ssm get-parameter --name /mfc-demo/alarm-email --query Parameter.Value --output text)"   # never echo it
   plan_file="$(mktemp)" && chmod 600 "$plan_file"
   terraform plan -out="$plan_file"
   ```

   Record the rollback target before the apply. IAM keeps at most 5 versions of a policy, and the rollback below needs the
   earlier version to still exist. The default version listed now is the one to roll back to (it is not always `v1`: after
   PR C it was `v2` for the boundary and deploy-core). The three ARNs use the lookup of the rollback section, and deploy-data is listed with the other two because the
   rollback is a pair.

   ```bash
   BOUNDARY_ARN="$(aws iam list-policies --scope Local --path-prefix /mfc-demo-ci/ --query "Policies[?PolicyName=='mfc-demo-workload-boundary'].Arn" --output text)"
   CORE_ARN="$(aws iam list-policies --scope Local --path-prefix /mfc-demo-ci/ --query "Policies[?PolicyName=='mfc-demo-deploy-core'].Arn" --output text)"
   DATA_ARN="$(aws iam list-policies --scope Local --path-prefix /mfc-demo-ci/ --query "Policies[?PolicyName=='mfc-demo-deploy-data'].Arn" --output text)"
   for ARN in "$BOUNDARY_ARN" "$CORE_ARN" "$DATA_ARN"; do
     aws iam list-policy-versions --policy-arn "$ARN" --query 'Versions[].[VersionId,IsDefaultVersion,CreateDate]' --output text
   done
   ```

2. Check the plan against the expected one.

   **Expected plan: the one in the pull request description** (PR C: `Plan: 1 to add, 3 to change, 0 to destroy.`).

   - add: `aws_s3_account_public_access_block.this`
   - update in place (only the `policy` attribute): `aws_iam_policy.workload_boundary`, `aws_iam_policy.deploy_core`, `aws_iam_policy.deploy_data`
   - nothing else. In particular no change to `aws_ssm_parameter.alarm_email` (same value), to any role or attachment, or to the state
     bucket. No `-/+` and no `must be replaced`. **Any other line means stop and report: do not apply.** Then run
     `rm -f "$plan_file"; unset TF_VAR_alarm_email`.

   The three updated policies are applied in order: `mfc-demo-deploy-data` before `mfc-demo-deploy-core` (`depends_on`), so the
   denies that move to deploy-data exist before deploy-core stops carrying them. The apply must not run while a deploy runs.

3. Check the rendered policies of the saved plan with Access Analyzer. It prints only finding types. Step 4 applies only if
   this step printed nothing.

   ```bash
   findings="$(terraform show -json "$plan_file" | jq -r '.resource_changes[] | select(.type=="aws_iam_policy") | .change.after.policy' |
     while read -r doc; do aws accessanalyzer validate-policy --region eu-west-3 --policy-type IDENTITY_POLICY --policy-document "$doc" \
       --query 'findings[?findingType!=`SUGGESTION`].[findingType,issueCode]' --output text; done)"
   printf '%s' "$findings"   # expected: no output
   ```

4. Apply, then remove the saved plan.

   ```bash
   if [ -z "$findings" ]; then terraform apply "$plan_file"; else echo "Access Analyzer findings: stop and report, do not apply" >&2; fi
   rm -f "$plan_file"            # the saved plan holds the alarm address in clear text (R17)
   unset TF_VAR_alarm_email
   ```

IAM side: each policy gets a new version v2 as the default, and v1 is kept. Each policy has a single version today, so the
provider deletes no old version (it prunes only at 5).

**Rollback**

- The plan is not as expected: do nothing. Nothing has changed.
- After the apply, the dispatched deploy fails with AccessDenied on a refresh read. The immediate, reversible fix is to
  roll the CI policies back to the rollback target noted in step 1. It is a write: each
  `set-default-policy-version` needs the owner's explicit approval, given separately. The two policies are rolled back
  together, deploy-core first then deploy-data. One policy alone is never rolled back: the state bucket and trail denies
  moved from deploy-core to deploy-data, so deploy-data alone on v1 re-allows state bucket administration and trail
  object writes (simulate-custom-policy, 2026-11-01).

  ```bash
  CORE_ARN="$(aws iam list-policies --scope Local --path-prefix /mfc-demo-ci/ --query "Policies[?PolicyName=='mfc-demo-deploy-core'].Arn" --output text)"
  DATA_ARN="$(aws iam list-policies --scope Local --path-prefix /mfc-demo-ci/ --query "Policies[?PolicyName=='mfc-demo-deploy-data'].Arn" --output text)"
  aws iam set-default-policy-version --policy-arn "$CORE_ARN" --version-id v1   # first, with the owner's approval
  aws iam set-default-policy-version --policy-arn "$DATA_ARN" --version-id v1   # then, with the owner's approval
  ```

  Then a fix PR. The next bootstrap plan shows the drift, and the apply of the fix restores the code version.

- Full revert: `git revert` of PR C in a new PR, then the bootstrap apply. The account block is protected by `prevent_destroy`, so the revert
  PR must keep `account.tf`, or replace it with the block below.

  ```hcl
  removed {
    from = aws_s3_account_public_access_block.this

    lifecycle {
      destroy = false
    }
  }
  ```

  Turning the account setting off is never part of a rollback: nothing depends on public access.

- The account block can only break public buckets or objects, and there are none (see ADR 0024).

## Read-only verification (SSO profile `mfc`)

Run `aws sso login --profile mfc` first. The commands below never print the account id: every output goes through
`sed -E 's/[0-9]{12}/<acct>/g'`.

### V0 — before merge, offline render plus Access Analyzer (free, read-only)

Run from the repository root. V0 keeps the rendered files in `$W` for V0b, which removes the directory at its end.

```bash
export AWS_PROFILE=mfc
W="$(mktemp -d)"
cp infra/bootstrap/*.tf infra/bootstrap/terraform.tfvars infra/bootstrap/.terraform.lock.hcl "$W"/
cat > "$W/override.tf" <<'X'
terraform {
  backend "local" {}
}
locals {
  account_id            = "123456789012"
  workload_boundary_arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
}
X
cd "$W" && env -u AWS_PROFILE AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x terraform init -input=false >/dev/null
for p in workload_boundary deploy_core deploy_data; do
  echo "jsonencode(local.${p}_policy)" | env -u AWS_PROFILE AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x \
    terraform console -var alarm_email=a@example.com | tail -1 | python3 -I -c 'import sys,json;print(json.loads(sys.stdin.read()))' > "$p.json"
  echo "== $p $(wc -c < $p.json)"
  aws accessanalyzer validate-policy --region eu-west-3 --policy-type IDENTITY_POLICY --policy-document "file://$p.json" \
    --query 'findings[?findingType!=`SUGGESTION`].[findingType,issueCode]' --output text
done
```

Expected: sizes of 2943 (workload boundary), 4608 (deploy core) and 1059 (deploy data), one byte more than the policy size
because of the newline, and **no output lines** from validate-policy. Before PR C, the old deploy-core listed three action
names that do not exist, and validate-policy reported them as `ERROR INVALID_ACTION`. The override file only changes locals and
the backend. The fake keys keep the console from ever reaching AWS.

### V0b — before merge, pre-verify the new decisions with simulate-custom-policy

Run in the same shell as V0, in its directory `$W`. Use the rendered JSON from V0 (with the fake account `123456789012` in the ARNs)
and a stand-in for ReadOnlyAccess:

```bash
echo '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:Get*","s3:List*","cloudtrail:Get*","cloudtrail:Describe*","cloudtrail:List*"],"Resource":"*"}]}' > ro.json
# render deploy_compute, deploy_edge, deploy_iot the same way as in V0, then:
P="$(python3 -I -c "import json;print(json.dumps([open(f).read() for f in ['deploy_core.json','deploy_data.json','deploy_compute.json','deploy_edge.json','deploy_iot.json','ro.json']]))")"
sim(){ r=$1; shift; aws iam simulate-custom-policy --policy-input-list "$P" --action-names "$@" --resource-arns "$r" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text | sed "s|^|$r  |"; }
```

then the same `sim` calls as V2, with `123456789012` instead of the real account. Results observed on the prototype: exactly the "after"
column of V2. This block is the last one that reads `$W`, so it ends by removing the directory, which holds the fake account id:

```bash
cd - >/dev/null && rm -rf "$W"
```

### V1 — the boundary, before and after apply (simulate-custom-policy; no workload role exists yet)

```bash
export AWS_PROFILE=mfc; W="$(mktemp -d)"; cd "$W"; A=$(aws sts get-caller-identity --query Account --output text)
B="arn:aws:iam::$A:policy/mfc-demo-ci/mfc-demo-workload-boundary"
V=$(aws iam get-policy --policy-arn "$B" --query Policy.DefaultVersionId --output text)
aws iam get-policy-version --policy-arn "$B" --version-id "$V" --query PolicyVersion.Document --output json > boundary.json
echo '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:*","Resource":"*"}]}' > broad.json
ID="$(python3 -I -c "import json;print(json.dumps([open('broad.json').read()]))")"
BP="$(python3 -I -c "import json;print(json.dumps([open('boundary.json').read()]))")"
for r in arn:aws:s3:::mfc-demo-trail-vinsl arn:aws:s3:::mfc-demo-trail-vinsl/AWSLogs/probe arn:aws:s3:::mfc-demo-maps-vinsl/x '*'; do
  aws iam simulate-custom-policy --policy-input-list "$ID" --permissions-boundary-policy-input-list "$BP" \
    --action-names s3:GetObject s3:DeleteObject s3:PutObject s3:PutLifecycleConfiguration s3:PutBucketPolicy s3:PutAccountPublicAccessBlock \
    --resource-arns "$r" --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text | tr '\n\t' ' =' | sed "s|^|$r: |"; echo
done
cd - >/dev/null && rm -rf "$W"
```

The list parameters must be JSON arrays of document strings. `file://` on a list parameter fails with "length <= 10".

| Resource                             | Before (observed 2026-11-01, live v1)                                                                                                | After                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| trail bucket and `.../AWSLogs/probe` | all six S3 actions **allowed** (the trail bucket reachable through the boundary, ADR 0024), PutAccountPublicAccessBlock implicitDeny | the five S3 actions **explicitDeny**, PutAccountPublicAccessBlock implicitDeny |
| `mfc-demo-maps-vinsl/x`              | allowed                                                                                                                              | allowed (only the trail is carved out)                                         |
| `*`                                  | all implicitDeny                                                                                                                     | all implicitDeny                                                               |

### V2 — the deploy role, before and after apply (simulate-principal-policy, one resource per call)

```bash
export AWS_PROFILE=mfc; W="$(mktemp -d)"; cd "$W"; A=$(aws sts get-caller-identity --query Account --output text)
R="arn:aws:iam::$A:role/mfc-demo-ci/mfc-demo-gha-deploy"
sim(){ r=$1; shift; aws iam simulate-principal-policy --policy-source-arn "$R" --action-names "$@" --resource-arns "$r" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text | sed -E "s/[0-9]{12}/<acct>/g; s|^|${r//$A/<acct>}  |"; }
TB=arn:aws:s3:::mfc-demo-trail-vinsl
sim $TB s3:ListBucket s3:GetBucketPolicy s3:GetLifecycleConfiguration s3:GetEncryptionConfiguration s3:GetBucketPublicAccessBlock s3:GetBucketOwnershipControls s3:GetBucketVersioning s3:GetBucketTagging s3:ListTagsForResource s3:PutBucketTagging s3:TagResource s3:UntagResource
sim $TB s3:CreateBucket s3:DeleteBucket s3:PutBucketPolicy s3:DeleteBucketPolicy s3:PutBucketVersioning s3:PutLifecycleConfiguration s3:PutEncryptionConfiguration s3:PutBucketPublicAccessBlock s3:PutBucketOwnershipControls s3:PutBucketAcl s3:PutBucketLogging s3:PutBucketNotification s3:PutReplicationConfiguration s3:PutInventoryConfiguration s3:PutIntelligentTieringConfiguration s3:PutBucketAbac
sim $TB/AWSLogs/probe s3:GetObject s3:GetObjectVersion s3:PutObject s3:DeleteObject s3:DeleteObjectVersion s3:PutObjectTagging s3:RestoreObject s3:ReplicateObject s3:ReplicateDelete
sim arn:aws:s3:::mfc-demo-console-vinsl s3:CreateBucket s3:PutBucketPolicy s3:PutLifecycleConfiguration
sim arn:aws:s3:::mfc-demo-tfstate-vinsl s3:PutBucketPolicy s3:PutEncryptionConfiguration s3:GetBucketPolicy
sim '*' s3:PutAccountPublicAccessBlock s3:GetAccountPublicAccessBlock
sim arn:aws:cloudtrail:eu-west-3:$A:trail/mfc-demo-trail cloudtrail:CreateTrail cloudtrail:StartLogging cloudtrail:AddTags cloudtrail:RemoveTags cloudtrail:StopLogging cloudtrail:DeleteTrail cloudtrail:UpdateTrail cloudtrail:PutEventSelectors cloudtrail:GetTrailStatus cloudtrail:DescribeTrails
sim arn:aws:cloudtrail:eu-west-3:$A:trail/mfc-demo-trail-2 cloudtrail:CreateTrail cloudtrail:StartLogging
sim arn:aws:cloudtrail:us-east-1:$A:trail/mfc-demo-trail cloudtrail:CreateTrail
cd - >/dev/null && rm -rf "$W"
```

Expected:

| Call group                                                                             | Before (live, observed partially)                                        | After                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| trail bucket reads and the 3 tag actions                                               | allowed                                                                  | **allowed**                                  |
| trail bucket Create/Delete/Put* (16 actions)                                           | allowed (PutBucketPolicy and PutLifecycleConfiguration observed allowed) | **explicitDeny** (all 16)                    |
| trail objects GetObject, GetObjectVersion                                              | allowed                                                                  | allowed                                      |
| trail objects PutObject, PutObjectTagging, RestoreObject, Replicate*                   | allowed (PutObject observed)                                             | **explicitDeny**                             |
| trail objects DeleteObject, DeleteObjectVersion                                        | explicitDeny (observed)                                                  | explicitDeny                                 |
| console bucket CreateBucket, PutBucketPolicy, PutLifecycleConfiguration                | allowed                                                                  | allowed                                      |
| state bucket PutBucketPolicy, PutEncryptionConfiguration / GetBucketPolicy             | explicitDeny / allowed                                                   | explicitDeny / allowed                       |
| `*` PutAccountPublicAccessBlock / GetAccountPublicAccessBlock                          | implicitDeny (observed) / allowed                                        | **explicitDeny** / allowed                   |
| trail/mfc-demo-trail StartLogging, AddTags, RemoveTags, GetTrailStatus, DescribeTrails | allowed                                                                  | allowed                                      |
| trail/mfc-demo-trail CreateTrail                                                       | allowed                                                                  | **explicitDeny** (fallback variant: allowed) |
| trail/mfc-demo-trail StopLogging, DeleteTrail, UpdateTrail, PutEventSelectors          | explicitDeny                                                             | explicitDeny                                 |
| trail/mfc-demo-trail-2 CreateTrail, StartLogging                                       | allowed                                                                  | **explicitDeny / implicitDeny**              |
| us-east-1 trail/mfc-demo-trail CreateTrail                                             | implicitDeny                                                             | explicitDeny                                 |

### V3 — the plan role (sanity)

`sim` with `R=.../mfc-demo-gha-plan`: `'*' s3:PutAccountPublicAccessBlock` gives implicitDeny, and `$TB s3:PutBucketPolicy` gives implicitDeny.

### V4 — after apply

- `aws s3control get-public-access-block --account-id "$A" --query PublicAccessBlockConfiguration --output text` gives `True True True True`.
- `aws cloudtrail get-trail-status --name mfc-demo-trail --query '[IsLogging,LatestDeliveryError]' --output text` gives `True None`.
- Dispatch `deploy.yml` on main (allow_destroy=false): the plan says "No changes", the apply is a no-op and the smoke test is green. **This is the proof that every refresh read still passes.**
- Re-run V0 on the deployed versions (`get-policy-version` of the new default versions) through validate-policy: no ERROR.
