import addressparser from "nodemailer/lib/addressparser";

/** Reject empty/missing mailboxes without changing legacy display-name values. */
export function hasRecipientMailboxes(to: string | string[]): boolean {
  const values = Array.isArray(to) ? to : [to];
  return (
    values.length > 0 &&
    values.every((value) => {
      const addresses = addressparser(value, { flatten: true });
      return (
        addresses.length > 0 &&
        addresses.every(({ address }) => {
        const separator = address.lastIndexOf("@");
        return (
          separator > 0 &&
          address.slice(0, separator).trim().length > 0 &&
          address.slice(separator + 1).trim().length > 0
        );
        })
      );
    })
  );
}
