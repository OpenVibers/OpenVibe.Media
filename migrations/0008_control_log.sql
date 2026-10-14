-- phase: expand
-- ADR-048 control operations (plan T13 step 10, server/registry/resource-control.js): the first answer to each
-- (caller, project, idempotency_key), returned again for a repeat so a retried control request never applies twice.
CREATE TABLE media_control_log (
    caller          text COLLATE "C" NOT NULL,          -- svc:… that sent it
    project_id      text COLLATE "C" NOT NULL,
    idempotency_key text COLLATE "C" NOT NULL,
    digest          text COLLATE "C" NOT NULL,          -- sha256 of the request without its delivery fields
    response        jsonb NOT NULL,                     -- the common.resource-control-result@1 answered
    created_at      bigint NOT NULL,
    PRIMARY KEY (caller, project_id, idempotency_key)
);
