import {itBench} from "@dapplion/benchmark";

describe("misc / throw vs return", () => {
  const count = 1000;

  type Status = {code: string; value: number};

  class ErrorStatus extends Error implements Status {
    constructor(readonly code: string, readonly value: number) {
      super(code);
    }
  }

  function statusReturnObject(i: number): Status {
    return {
      code: "OK",
      value: i,
    };
  }

  function statusReturnError(i: number): Status {
    return new ErrorStatus("OK", i);
  }

  function statusThrowObject(i: number): never {
    throw {
      code: "OK",
      value: i,
    };
  }

  function statusThrowError(i: number): never {
    throw new ErrorStatus("OK", i);
  }

  itBench({
    id: `Return object ${count} times`,
    noThreshold: true,
    runsFactor: count,
    fn: () => {
      for (let i = 0; i < count; i++) {
        const res = statusReturnObject(i);
        res.code;
      }
    },
  });

  itBench({
    id: `Return Error ${count} times`,
    noThreshold: true,
    runsFactor: count,
    fn: () => {
      for (let i = 0; i < count; i++) {
        const res = statusReturnError(i);
        res.code;
      }
    },
  });

  itBench({
    id: `Throw object ${count} times`,
    noThreshold: true,
    runsFactor: count,
    fn: () => {
      for (let i = 0; i < count; i++) {
        try {
          statusThrowObject(i);
        } catch (e) {
          (e as Status).code;
        }
      }
    },
  });

  itBench({
    id: `Throw Error ${count} times`,
    noThreshold: true,
    runsFactor: count,
    fn: () => {
      for (let i = 0; i < count; i++) {
        try {
          statusThrowError(i);
        } catch (e) {
          (e as Status).code;
        }
      }
    },
  });
});
