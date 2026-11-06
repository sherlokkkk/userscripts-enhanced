// Safari may leave a native request pending when its helper is unavailable.
// Bound UI waits, but never retry a potentially mutating request automatically.
export function createNativeClient(
	runtime,
	{
		application = "application",
		timeoutMs = 90_000,
		startupTimeoutMs = 10_000,
	} = {},
) {
	const startupRequests = new Set([
		"REQ_PLATFORM",
		"PAGE_INIT_DATA",
		"PAGE_ALL_FILES",
		"NATIVE_CHECKS",
	]);
	return function sendNativeMessage(message) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (callback, result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				callback(result);
			};
			const failed = (cause) => {
				const error = new Error(
					`Native helper unavailable (${message?.name ?? "request"}): ${cause?.message ?? cause}`,
				);
				error.cause = cause;
				finish(reject, error);
			};
			const timer = setTimeout(
				() =>
					failed(
						new Error(
							"Request timed out. Check that the installed Enhanced app and extension match, then retry. The native operation may still be running.",
						),
					),
				startupRequests.has(message?.name) ? startupTimeoutMs : timeoutMs,
			);
			try {
				Promise.resolve(runtime.sendNativeMessage(application, message)).then(
					(response) => {
						if (response === undefined || response === null)
							failed(new Error("Native helper returned no response"));
						else finish(resolve, response);
					},
					failed,
				);
			} catch (error) {
				failed(error);
			}
		});
	};
}
