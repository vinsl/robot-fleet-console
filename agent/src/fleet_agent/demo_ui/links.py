"""Builds the three read-only links: the console, the Cognito users and the IoT things.

The links are built from the stack outputs only. They open the AWS console of the operator, which
asks for the operator's own sign-in: the page never reads these consoles itself.
"""

from __future__ import annotations

from dataclasses import dataclass

from fleet_agent.demo_ui.outputs import StackOutputs


@dataclass(frozen=True)
class Links:
    """The three links of the demo, as absolute URLs."""

    console_url: str
    cognito_users_url: str
    iot_things_url: str


def build_links(outputs: StackOutputs) -> Links:
    """Builds the links from the stack outputs.

    Args:
        outputs: The validated outputs.

    Returns:
        The console origin, the Cognito user list of the pool, and the IoT thing hub of the
        region.
    """
    region = outputs.region
    return Links(
        console_url=outputs.console_origin,
        cognito_users_url=(
            f"https://{region}.console.aws.amazon.com/cognito/v2/idp/user-pools/"
            f"{outputs.user_pool_id}/users?region={region}"
        ),
        iot_things_url=f"https://{region}.console.aws.amazon.com/iot/home?region={region}#/thinghub",
    )
