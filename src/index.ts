import { Worker } from "@notionhq/workers";

// Worker entrypoint. The Raindrop -> Notion sync capability is registered here.
// Full implementation follows design approval; this stub establishes the
// project structure and verifies the toolchain.
const worker = new Worker();
export default worker;
