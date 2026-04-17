/**
 * GraphQL documents for features not yet in the high-level SDK.
 * Uses gql tagged templates for proper TypedDocumentNode compatibility.
 */

import gql from "graphql-tag";

// ── Intercept ──
// Caido 0.56+: InterceptRequest/ResponseOptions.filter is now a Query union
// (HTTPQL | StreamQL) that needs subfields; Pause/ResumeInterceptPayload
// no longer have `request`/`response` fields, only `status`.

export const INTERCEPT_OPTIONS_QUERY = gql`
  query {
    interceptOptions {
      request {
        enabled
        filter {
          ... on HTTPQL { code }
          ... on StreamQL { code }
        }
      }
      response {
        enabled
        filter {
          ... on HTTPQL { code }
          ... on StreamQL { code }
        }
      }
      scope { scopeId }
    }
  }
`;

export const PAUSE_INTERCEPT = gql`
  mutation {
    pauseIntercept { status }
  }
`;

export const RESUME_INTERCEPT = gql`
  mutation {
    resumeIntercept { status }
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

// ── Replay: create session with raw source ──
// Caido 0.56+ types the inner raw field as Blob. SDK 0.2.0's sessions.create
// still passes the raw string through unencoded, so we issue the mutation
// ourselves with base64-encoded bytes for send-raw.

export const CREATE_REPLAY_SESSION_RAW = gql`
  mutation($input: CreateReplaySessionInput!) {
    createReplaySession(input: $input) {
      session { id name }
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
