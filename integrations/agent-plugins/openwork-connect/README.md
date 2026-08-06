# OpenWork Connect Agent Plugin

This directory is the portable Agent Plugins 1.0.0 package for OpenWork
Connect. Install or copy the complete directory through an Agent
Plugins-compatible client. The package installs:

- the remote OpenWork MCP endpoint;
- guidance for the `search_capabilities` and `execute_capability` workflow;
- no credentials or client-specific authentication configuration.

The MCP client discovers OpenWork OAuth from the endpoint and opens the normal
browser sign-in flow. Access remains scoped to the selected organization and
the signed-in member's grants.

Agent Plugins does not standardize registries or installation UX. Distribution
of this directory is therefore client-specific.
