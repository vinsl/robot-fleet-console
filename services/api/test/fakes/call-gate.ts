/**
 * Call recording and failure injection shared by the in-memory fakes of the robot use cases.
 */

/** One scripted failure: the error to reject with, and how many more calls it affects. */
interface ScriptedFailure {
  readonly error: Error;
  remaining: number;
}

/**
 * Records every call of a fake in a log and rejects the calls a test scripted to fail.
 *
 * The log can be shared between fakes, so a test can assert the order of calls across IoT and video.
 */
export class CallGate<Method extends string> {
  private readonly failures = new Map<Method, ScriptedFailure>();

  /**
   * @param log - Log that receives one `<service>.<method>` entry per call.
   * @param service - Prefix of the entries written by this fake.
   */
  constructor(
    private readonly log: string[],
    private readonly service: string,
  ) {}

  /**
   * Makes the next calls of a method reject.
   *
   * @param method - The method to fail.
   * @param error - The error to reject with.
   * @param times - How many calls fail; once by default.
   */
  fail(method: Method, error: Error, times = 1): void {
    this.failures.set(method, { error, remaining: times });
  }

  /**
   * Records a call, and returns a rejected promise if a failure is scripted for it.
   *
   * @param method - The method being called.
   * @returns A resolved promise, or a promise rejected with the scripted error.
   */
  enter(method: Method): Promise<void> {
    this.log.push(`${this.service}.${method}`);
    const scripted = this.failures.get(method);
    if (scripted !== undefined && scripted.remaining > 0) {
      scripted.remaining -= 1;
      return Promise.reject(scripted.error);
    }
    return Promise.resolve();
  }
}

/**
 * Builds an error named like an AWS service error code, the way the SDK reports them.
 *
 * @param name - The service error code.
 * @returns An error whose `name` is the code.
 */
export function awsError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
