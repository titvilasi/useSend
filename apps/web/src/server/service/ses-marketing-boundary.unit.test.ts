import { SESv2Client, SendEmailCommandOutput } from "@aws-sdk/client-sesv2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({
  env: {
    AWS_ACCESS_KEY: "owned-local-key",
    AWS_SECRET_KEY: "owned-local-secret",
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_SES_ENDPOINT: "https://ses.owned.invalid",
  },
}));
vi.mock("../db", () => ({ db: {} }));
vi.mock("../logger/log", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import { sendRawEmail } from "../aws/ses";

const calls: number[] = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("AWS_MAX_ATTEMPTS", "3");
  const fake = async function (
    this: SESv2Client,
  ): Promise<SendEmailCommandOutput> {
    calls.push(await this.config.maxAttempts());
    return { MessageId: "ses_owned", $metadata: { httpStatusCode: 200 } };
  };
  vi.spyOn(SESv2Client.prototype, "send").mockImplementation(
    fake as typeof SESv2Client.prototype.send,
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const base = {
  to: ["owned@example.invalid"],
  from: "sender@example.invalid",
  subject: "Synthetic",
  text: "Synthetic",
  region: "us-east-1",
  configurationSetName: "owned-config",
};
function boundary() {
  return {
    expiresAt: null as string | null,
    submitBefore: "2030-01-01T00:00:00Z",
    now: () => new Date("2026-10-28T00:00:00Z"),
    beforeSubmit: vi.fn().mockResolvedValue(undefined),
    onSdkInvocation: vi.fn(),
  };
}

describe("marked SES boundary with an in-process SDK send fake", () => {
  it("requires the separate Native technical permit deadline at final SDK invocation", async () => {
    const marketing = { ...boundary(), submitBefore: "2020-01-01T00:00:00Z" };
    await expect(sendRawEmail({ ...base, marketing })).rejects.toThrow(
      "NATIVE_SUBMIT_WINDOW_ELAPSED",
    );
    expect(calls).toEqual([]);
  });
  it("uses maxAttempts one only for the new marked path", async () => {
    const marketing = boundary();
    await sendRawEmail({ ...base, marketing });
    expect(calls).toEqual([1]);
    expect(marketing.beforeSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["owned@example.invalid"],
        cc: [],
        bcc: [],
        recipientCount: 1,
      }),
    );
    expect(marketing.onSdkInvocation).toHaveBeenCalledTimes(1);
  });
  it("keeps legacy recipient formats and retry defaults unchanged", async () => {
    await sendRawEmail({
      ...base,
      to: ['"Name" <one@example.invalid>, two@example.invalid'],
      cc: ["copy@example.invalid"],
    });
    expect(calls).toEqual([3]);
  });
  it.each([
    { to: ["one@example.invalid, two@example.invalid"] },
    { to: ["one@example.invalid", "two@example.invalid"] },
    { cc: ["copy@example.invalid"] },
    { bcc: ["blind@example.invalid"] },
  ])("rejects actual multi-recipient marked envelopes: %j", async (change) => {
    const marketing = boundary();
    await expect(
      sendRawEmail({ ...base, ...change, marketing }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(marketing.beforeSubmit).not.toHaveBeenCalled();
  });
  it("checks the real expiry after the final asynchronous boundary work", async () => {
    let clock = new Date("2026-10-28T00:00:00Z");
    const marketing = {
      ...boundary(),
      expiresAt: "2026-10-28T00:00:00.100Z",
      now: () => clock,
      beforeSubmit: vi.fn(async () => {
        clock = new Date("2026-10-28T00:00:00.200Z");
      }),
    };
    await expect(sendRawEmail({ ...base, marketing })).rejects.toThrow();
    expect(marketing.beforeSubmit).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });
});
