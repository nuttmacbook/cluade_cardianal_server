/**
 * Hello World program
 *
 * 3 rules
 *   1. The whole file must be in a single scope, i.e. one wrapping function (any name)
 *   2. The return at the end of the function = the list of functions others may call
 *   3. No imports · the program must be self-contained
 */
export default function program() {
  // runs once at install — cannot be called from outside
  function initialization(params) {
    writeDB("greeting", params.input.greeting ?? "Hello");
    writeDB("owner", params.context.sender);
    writeDB("count", 0n);   // numbers in programs are always BigInt
  }

  // not in the return = internal to the program only
  function bump() {
    const next = (readDB("count") ?? 0n) + 1n;
    writeDB("count", next);
    return next;
  }

  function greet(params) {
    const name = params.input.name ?? params.context.sender;
    const times = bump();
    writeDB(map("visits", params.context.sender), times);
    return `${readDB("greeting")} ${name} (visit ${times})`;
  }

  function setGreeting(params) {
    if (params.context.sender !== readDB("owner")) throw new Error("owner only");
    writeDB("greeting", params.input.greeting);
    return readDB("greeting");
  }

  function info(params) {
    return {
      greeting: readDB("greeting"),
      owner: readDB("owner"),
      count: readDB("count") ?? 0n,
      address: ThisAddress(),
      time: params.block.timestamp,   // BigInt (Date.now() in programs is a number → wrap in BigInt() before storing / returning)
    };
  }

  return { greet, setGreeting, info };
}
