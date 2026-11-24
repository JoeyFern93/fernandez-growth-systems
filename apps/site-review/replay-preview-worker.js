import { replayPreview } from "./replay-pair.js";
import { replayRelay, relaySchema } from "./replay-relay.js";

export default {
  fetch(request, env) {
    return replayPreview(request,env,{replayRelay,relaySchema});
  }
};
