"""Golden tests of the three links: the console, the Cognito user list and the IoT thing hub."""

from __future__ import annotations

from fleet_agent.demo_ui.links import build_links
from tests.demo_ui.fakes import STACK


def test_links_are_built_from_the_stack_outputs() -> None:
    links = build_links(STACK)

    assert links.console_url == "https://d111aaa.cloudfront.net"
    assert links.cognito_users_url == (
        "https://eu-west-3.console.aws.amazon.com/cognito/v2/idp/user-pools/"
        "eu-west-3_AbC123/users?region=eu-west-3"
    )
    assert links.iot_things_url == (
        "https://eu-west-3.console.aws.amazon.com/iot/home?region=eu-west-3#/thinghub"
    )
