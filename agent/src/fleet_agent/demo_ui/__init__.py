"""Local demo control page: start and stop the simulated fleet, and open the read-only links.

The page runs on the operator's machine, bound to 127.0.0.1, with the operator's own AWS session
through the `aws` CLI. It changes no infrastructure. It creates or resets Operator and Viewer
accounts only through `scripts/bootstrap-admin.sh`, and shows a temporary password once in the
answer to that request. See ADRs 0071 and 0076.
"""
