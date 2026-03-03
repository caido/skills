/**
 * GraphQL documents for features not yet in the high-level SDK.
 * Uses gql tagged templates for proper TypedDocumentNode compatibility.
 */

import gql from "graphql-tag";

// ── Intercept ──

export const INTERCEPT_OPTIONS_QUERY = gql`
  query {
    interceptOptions {
      request { enabled filter }
      response { enabled filter }
      scope { scopeId }
    }
  }
`;

export const PAUSE_INTERCEPT = gql`
  mutation {
    pauseIntercept {
      request { enabled }
      response { enabled }
    }
  }
`;

export const RESUME_INTERCEPT = gql`
  mutation {
    resumeIntercept {
      request { enabled }
      response { enabled }
    }
  }
`;

// ── Automate / Fuzz ──

export const CREATE_AUTOMATE_SESSION = gql`
  mutation($input: CreateAutomateSessionInput!) {
    createAutomateSession(input: $input) {
      session {
        id
        name
        connection { host port isTLS }
        raw
      }
    }
  }
`;

export const GET_AUTOMATE_SESSION = gql`
  query($id: ID!) {
    automateSession(id: $id) {
      id
      name
      connection { host port isTLS }
      raw
      settings {
        payloads { options { ... on AutomateSimpleListPayload { list } } }
      }
    }
  }
`;

export const START_AUTOMATE_TASK = gql`
  mutation($automateSessionId: ID!) {
    startAutomateTask(automateSessionId: $automateSessionId) {
      automateTask { id paused }
    }
  }
`;

// ── Plugins ──

export const PLUGIN_PACKAGES_QUERY = gql`
  query {
    pluginPackages {
      id
      manifestId
      name
      version
      plugins {
        ... on PluginBackend { id manifestId name enabled state { running error } }
        ... on PluginFrontend { id manifestId name enabled }
        ... on PluginWorkflow { id manifestId name enabled }
      }
    }
  }
`;
