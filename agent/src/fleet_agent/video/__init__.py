"""Local video page of the robot agent: a loopback web page that shows the robot's camera.

The page is served on the robot's loopback interface only. It claims a one-time token, receives
temporary credentials for the robot's own signalling channel, and polls the robot's status. It has
no route that reaches the robot's core, so it cannot command the robot.
"""
