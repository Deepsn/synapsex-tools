/* eslint-disable curly */
import { ProgressLocation, window, ExtensionContext, StatusBarAlignment, commands, workspace } from "vscode";
import websocket from "websocket-as-promised";
import ws, {WebSocketServer} from "ws";
import actions from "./actions.json";

const mainUrl = "ws://localhost:24892/";
const wsTimeout = 2 * 60 * 1000;
var active = false;

const sExecute = new websocket(mainUrl + "execute", {
	createWebSocket: url => new ws(url),
	extractMessageData: event => event
});
const sAttach = new websocket(mainUrl + "attach", {
	createWebSocket: url => new ws(url),
	extractMessageData: event => event
});
var sOutput: ws.Server<ws.WebSocket>;


function getConfig(scope: string): any | undefined {
	return workspace.getConfiguration("synapseXUtils")?.get(scope);
}

async function attemptConnection() {
	if (!sExecute.isOpened) {
		await sExecute.open();
		
	} if (!sAttach.isOpened) {
		await sAttach.open();
	}
}

function waitSocket(socket: websocket) {
	return new Promise((resolve, reject) => {
		let id = setTimeout(() => {
			reject("TIMEOUT");
		}, wsTimeout);

		socket.onMessage.addOnceListener((response) => {
			clearTimeout(id);

			if (response && response instanceof Buffer) {
				response = response.toString("utf-8");
			}

			resolve(response);
		});
	});
}


function notify(content: string, timeout?: number) {
	let timing = (getConfig("notificationTimeout") || 3) * 1000;

	window.withProgress({
		cancellable: false,
		title: content,
		location: ProgressLocation.Notification
	}, (progress) => {
		return new Promise<void>(resolve => {
			let perTiming = (timeout || timing) / 100;

			(function loop(x) {
				progress.report({ increment: 1 });

				setTimeout(() => {
					if (--x) loop(x);
					else {
						setTimeout(resolve, 100);
					}
				}, perTiming);
			})(100);
		});
	});
}



export async function activate(context: ExtensionContext) {
	console.log("Extension activated -");
	
	sOutput = new WebSocketServer({ port: 24892 });

	const output = window.createOutputChannel("Synapse X Output");
	const outputStatus = window.createStatusBarItem(StatusBarAlignment.Left);
	let executeButton = window.createStatusBarItem(StatusBarAlignment.Right);
	let lastTimeoutId: any = undefined;
	

	outputStatus.text = "$(loading~spin)";
	outputStatus.tooltip = "Output connection status";
	outputStatus.show();

	executeButton.text = actions.idle;
	executeButton.tooltip = "";
	executeButton.command = "synapsex-utils.execute";
	executeButton.show();



	
	async function attach() {
		// Trying to attach synapse
		console.log("Trying to attach");
		
		executeButton.text = actions.wait;
		sAttach.send("ATTACH");

		let success = null;
		let attachStatus = null;
		let validStatus = ["TRUE", "READY", "ALREADY_ATTACHED", "REATTACH_READY"];
		let invalidStatus = ["FALSE", "NOT_LATEST_VERSION", "FAILED_TO_FIND", "INTERRUPT", "TIMEOUT"];
		
		while (active) {
			let status = await waitSocket(sAttach)
				.catch((err) => {
					console.log("Error while waiting socket, error:", err);
					
					attachStatus = err;
					success = false;
				});
			
			console.log("Current attach status:", status);
			
			if (success === false) {
				break;
			}
			
			if (status && typeof(status) === "string") {
				executeButton.text = actions['wait-status'] + status;

				attachStatus = status;
				if (validStatus.includes(status)) {
					success = true;
					break;
					
				} else if (invalidStatus.includes(status)) {
					success = false;
					break;
				}
			}
		}

		console.log("Attach status:", success);

		return { success, attachStatus };
	}


	async function execute(content: string | undefined) {
		// Check if synapse is ready
		executeButton.text = actions.checking;

		sAttach.send("IS_READY");
		let status = await waitSocket(sAttach)
			.catch((errorCode) => {
				if (getConfig("showErrorMessages")) {
					notify("Synapse is not ready, error code: " + errorCode);
				}
			});
		
		console.log("Synapse status:", status);
		
		// Attach process
		if (status === "FALSE") {
			executeButton.text = actions.wait;

			const { success, attachStatus } = await attach();
			
			if (!success) {
				executeButton.text = actions["fail-inject"];
				if (getConfig("showErrorMessages")) {
					notify("Failed to inject, Status: " + (attachStatus || "TIMEOUT"));
				}
				return;
			}

		} else if (status === undefined) {
			executeButton.text = actions.fail;
			return;
		}

		// No content
		if (!content || content.trim() === "") {
			executeButton.text = actions.noContent;
			return;
		}

		executeButton.text = actions.loading;
		
		// Execute content
		sExecute.send(content);

		let executeStatus = await waitSocket(sExecute);
		
		if (executeStatus === "OK") {
			executeButton.text = actions.executed;

			if (getConfig("showSuccessMessages")) {
				notify("Executed");
			}

		} else {
			executeButton.text = actions.fail;
			
			if (getConfig("showErrorMessages")) {
				notify("Status code: " + executeStatus);
			}
		}
	}


	function forceParse(input: string) {
		let output = JSON.parse(input);

		if (typeof (output) === "string") {
			output = forceParse(input);
		}

		return output;
	}

	
	const executeCommand = commands.registerCommand('synapsex-utils.execute', async () => {
		if (active)
			return;
			
		active = true;
		const content = window.activeTextEditor?.document.getText();

		
		// Check WS connection & attempts if not connected
		executeButton.text = actions.checking;

		await attemptConnection()
			.then(() => {
				executeButton.text = actions.idle;
			})
			.catch(() => {
				executeButton.text = actions.reconnect;
			});

		// Execution process
		if (sAttach.isOpened && sExecute.isOpened) {
			await execute(content)
				.catch((err) => {
					console.log("failed:", err);
					
					executeButton.text = actions.fail;
				});
		}
				
		if (executeButton.text !== actions.idle) {
			let timing = getConfig("notificationTimeout") || 3;
			setTimeout(() => {
				executeButton.text = actions.idle;
				active = false;
			}, timing * 1000);

		} else {
			active = false;
		}
	});




	sAttach.onClose.addListener(async data => {
		if (data === 1005) {
			console.log("Closing socket");
			
			await sAttach.close();
			await sExecute.close();
		}
	});

	
	sOutput.on("connection", localWs => {
		if (lastTimeoutId) {
			clearTimeout(lastTimeoutId);
		}
		outputStatus.text = "$(testing-passed-icon)";
		
		localWs.on("message", buffedData => {
			if (lastTimeoutId) {
				clearTimeout(lastTimeoutId);
			}
	
			lastTimeoutId = setTimeout(() => {
				outputStatus.text = "$(testing-failed-icon)";
			}, 20 * 60 * 1000);


			// force JSON.parse to over-stringified strings
			let data = forceParse(buffedData.toString("utf-8"));

			if (data) {
				let message = data.message;
				let type = (data.messageType as string)?.replace("Message", "") || "output";
				let stacktrace = data.stacktrace;

				output.appendLine(`${type}:  ${message}`);

				if (stacktrace) {
					output.appendLine("\tStack Begin");
					output.appendLine("\t" + String(stacktrace));
					output.appendLine("\tStack End");
				}
			}
			
		});

		localWs.send("online");
	});

	
	context.subscriptions.push(executeCommand, executeButton, output, outputStatus);
}

export async function deactivate() {
	console.log("Deactivating extension");
	
	active = false;
	await sAttach.close();
	await sExecute.close();
	sOutput.close();
}
