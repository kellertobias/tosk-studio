import { exec as execChild } from 'child_process';

import {
	TMessageRates,
	TRateTypes,
	TMessageGlobalNorm,
} from '@/shared/types/rates';
import {
	TMacroStep,
	TMacroStepEmpty,
	TMessageMacro,
	TMessageMacroEmpty,
} from '@/shared/types/macro';
import { TMessageSceneList } from '@/shared/types/obs-scene';

import { BasicInterface } from '../basic-interface';
import { MicroWebsocketServer } from '../../engine/websocket-server';
import { MacroEngine } from '../../engine/macros';
import {
	ConfigBackend,
	DeviceParameters,
	deviceParametersTypes,
} from '../../engine/config';
import { IModules } from '../../modules';
import { Macro } from '../../engine/macros/macro';
import { MacroStep } from '../../engine/macros/step';
import { address } from '../../helpers/server-ip';

import { DeskKeyboardInterface } from './keyboard';

type TransitionRates = Record<TRateTypes, number>;

export class DeskWebInterface extends BasicInterface {
	public rateSelected: TRateTypes = 'master';
	public currentRates: TransitionRates = {
		obs: 1,
		master: 1,
		dsk1: 1,
		dsk2: 1,
	};
	public showTime: Date;
	public norms: TMessageGlobalNorm = {
		obs: {
			size: '0x0',
			fps: 1,
		},
		atem: {
			size: '0x0',
			fps: 1,
		},
	};
	public connectionStatus = {
		atem: false,
		obs: false,
		textgen: false,
	};

	private keyboard: DeskKeyboardInterface;
	private bootedAt: Date;
	private config: ConfigBackend;

	constructor(
		config: ConfigBackend,
		modules: IModules,
		macros: MacroEngine,
		ws: MicroWebsocketServer,
	) {
		super(config, modules, macros, ws);
		this.config = config;
		this.showTime = new Date(Date.now() + 1000 * 3600);

		this.keyboard = new DeskKeyboardInterface(
			config,
			this.modules,
			this.macros,
			this.ws,
		);
		this.bootedAt = new Date();
	}

	public connect(): Promise<void> {
		this.keyboard.connect();
		this.showTime = this.config.generic.showStart;
		return Promise.resolve();
	}
	public shutdown(): Promise<void> {
		this.keyboard.shutdown();
		return Promise.resolve();
	}

	private buildRatesAnswer(ratesIn: Partial<TransitionRates>): TMessageRates {
		return {
			_rateSelected: this.rateSelected,
			...this.currentRates,
			...ratesIn,
		};
	}

	private macroStepMap(
		macro: Macro,
		step: MacroStep | undefined,
	): TMacroStep | TMacroStepEmpty {
		if (!step) {
			return {};
		}
		return {
			name: step.name,
			trigger: step.trigger,
			running: step.running,
			index: step.stepNumber,
			done: step.done,
			started: step.started,
			triggerAt: step.triggerAt,
			duration: step.duration,
			iteration: 0,
			isLast: step.stepNumber === macro.steps.length - 1,
		};
	}

	private macroMap(
		macro: Macro | null,
		page: number,
		exec: number,
	): TMessageMacroEmpty | TMessageMacro {
		if (!macro) {
			return { exec: [page, exec], empty: true };
		}
		const maxSteps = 9;
		const currentStepNumber =
			(macro.earliestStepRunning - 1) % macro.steps.length;
		const maxStepNumber = (macro.latestStepRunning - 1) % macro.steps.length;
		const nextSteps = macro.steps
			.slice(Math.max(0, currentStepNumber))
			.map((step) => {
				return this.macroStepMap(macro, step);
			})
			.filter((x) => x)
			.slice(0, maxSteps + 1);

		const offset = currentStepNumber + nextSteps.length;

		if (macro.loop && nextSteps.length < maxSteps) {
			for (let extraIndex = 0; extraIndex < maxSteps; extraIndex++) {
				const extraStep = macro.steps[extraIndex % macro.steps.length];
				const mappedStep = this.macroStepMap(macro, extraStep);

				if (extraIndex + offset > maxStepNumber) {
					mappedStep.done = false;
					mappedStep.running = false;
					mappedStep.started = undefined;
					mappedStep.triggerAt = undefined;
				}
				if (currentStepNumber > extraIndex) {
					mappedStep.iteration = 0;
				} else {
					mappedStep.iteration =
						Math.floor(extraIndex / macro.steps.length) + 1;
					mappedStep.done = false;
					mappedStep.running = false;
					mappedStep.started = undefined;
					mappedStep.triggerAt = undefined;
				}

				nextSteps.push(mappedStep);
			}
		}
		return {
			name: macro.name,
			exec: macro.executor,
			isMaster: macro.isMaster,
			index: macro.index,
			loop: macro.loop,
			run: macro.running,
			wait: macro.waiting,
			currentIndex: currentStepNumber + 1,
			total: macro.steps.length,
			next: nextSteps,
		};
	}

	private publishGlobalSettings() {
		this.ws.publish('/d/system-settings', {
			channelMap: this.modules.atem.channelMap,
			brightnessMain: this.keyboard.brightnessMain,
			brightnessDim: this.keyboard.brightnessDim,
			panelIp: address,
			panelBoot: this.bootedAt,
		});
	}

	private publishInitialMacos() {
		if (this.macros.master) {
			this.ws.publish(
				'/d/macros/master',
				this.macroMap(this.macros.master, 0, 0),
			);
		}
		for (let index = 1; index <= 8; index++) {
			const macro = this.macros.getMacro(index);
			if (!macro) {
				this.ws.publish(
					`/d/macros/${index}`,
					this.macroMap(null, this.macros.page, index + 1),
				);
			} else {
				this.ws.publish(
					`/d/macros/${index}`,
					this.macroMap(macro, macro.executor[0], macro.executor[1]),
				);
			}
		}
	}

	private setupActions() {
		this.ws.methods({
			'/action/macros/reset': (params: { exec: number }) => {
				const { exec } = params;
				return this.macros.resetExec(exec);
			},
			'/action/macros/go': (params: { exec: number }) => {
				const { exec } = params;
				return this.macros.goExec(exec);
			},
			'/action/macros/master': (params: { macroIndex: number }) => {
				const { macroIndex } = params;
				return this.macros.selectMaster({ macroIndex });
			},
			'/action/rate/change': (params: { selectRate: TRateTypes }) => {
				const { selectRate } = params;
				this.rateSelected = selectRate;

				this.ws.publish('/d/trans-rate', this.buildRatesAnswer({}));

				return Promise.resolve();
			},
			'/action/scene/set': (params: { name: string }) => {
				this.modules.obs.scene.set(params);
				return Promise.resolve();
			},
			'/action/system/set-target-time': (params: { time: string }) => {
				const { time } = params;
				this.showTime = new Date(time);
				this.ws.publish('/d/calendar', { showStart: this.showTime });
				this.config.generic.showStart = this.showTime;
				this.config.store();
				return Promise.resolve();
			},
			'/action/system-settings/brightness': (params: {
				main: number;
				dim: number;
			}) => {
				const { main, dim } = params;
				this.keyboard.setBrightness(Number(main || 0), Number(dim || 0));
				this.publishGlobalSettings();
				return this.config.store();
			},
			'/action/system-settings/channel-map': (params: {
				channelMap: number[];
			}) => {
				const { channelMap } = params;
				this.modules.atem.setChannelMap(channelMap);
				this.publishGlobalSettings();
				return this.config.store();
			},
			'/action/system-settings/power': (params: {
				reload?: boolean;
				shutdown?: boolean;
				reboot?: boolean;
			}) => {
				switch (true) {
					case params.reload:
						this.macros.loadMacroStore();
						this.macros.init();
						return;
					case params.shutdown:
						console.log('GRACEFUL SHUTDOWN');
						// eslint-disable-next-line unicorn/no-process-exit
						process.exit();
						return;
					case params.reboot:
						console.log('REBOOT OF SERVER');
						execChild('shutdown now', (nodeErr, out) => {
							console.log('SHUTDOWN', out);
						});
						break;
					default:
						break;
				}
			},
			'/action/system-settings/devices': (params: {
				section: keyof ConfigBackend['devices'];
				parameter: keyof DeviceParameters;
				value: string | number | boolean;
			}) => {
				const { section, parameter, value } = params;
				const deviceConfig = this.config.devices[section];
				if (deviceConfig === undefined) {
					throw new Error('Wrong Section Name');
				}
				const requiredType = deviceParametersTypes[parameter];
				if (typeof value !== requiredType) {
					throw new TypeError('Value has wrong type');
				}

				// Type is asserted to be correct in the lines above.
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				// @ts-ignore
				deviceConfig[parameter] = value;

				return this.config.store();
			},
			'/action/loader/browser': (params: { subpath?: string[] }) => {
				return this.config.listShowFiles(params.subpath || []).then((files) => {
					return {
						files,
						current: {
							file: this.config.showfile,
							title: this.config.showfileTitle,
						},
					};
				});
			},
			'/action/loader/load': (params: { subpath: string[] }) => {
				this.config.setShowFile(params.subpath);
				this.macros.loadMacroStore();
				this.macros.init();

				this.publishInitialMacos();
			},
		});

		this.ws.publish('/d/trans-rate', this.buildRatesAnswer({}));
	}

	private setupDataSourcesMixer() {
		this.modules.atem.mix.onTransitionPosition((params) => {
			const { pos } = params;
			this.ws.publish('/d/trans-pos', pos);
		});

		this.modules.atem.mix.onTransitionRate((params) => {
			const { rate } = params;
			this.currentRates.master = rate;
			this.ws.publish('/d/trans-rate', this.buildRatesAnswer({ master: rate }));
		});

		this.modules.atem.dsk.onRate((param) => {
			const { rate } = param;
			const dsk = param.dsk as 'dsk1' | 'dsk2';

			this.currentRates[dsk] = rate;
			this.ws.publish('/d/trans-rate', this.buildRatesAnswer({ [dsk]: rate }));
		});

		this.modules.atem.onVideoModeChanged((param) => {
			const { height, mode, fps } = param;
			this.norms.atem = {
				size: `${height}${mode}`,
				fps,
			};

			this.ws.publish('/d/global', this.norms);

			this.connectionStatus.atem = true;
			this.ws.publish('/d/module-connection', this.connectionStatus);
		});
	}

	private setupDataSourcesObs() {
		this.modules.obs.onStatus((params) => {
			this.connectionStatus.obs = params.connected;
			this.ws.publish('/d/module-connection', this.connectionStatus);
		});

		this.modules.obs.scene.onListChanged((params) => {
			const { allScenes } = params;
			this.ws.publish('/d/scenes', allScenes as TMessageSceneList);
		});

		this.modules.obs.scene.onTransitionRateChanged((params) => {
			const { rate } = params;
			this.currentRates.obs = rate;
			this.ws.publish('/d/trans-rate', this.buildRatesAnswer({ obs: rate }));
		});

		this.modules.obs.generic.onVideoSetupChanged((params) => {
			const { height, fps } = params;
			this.norms.obs = {
				size: `${height}p`,
				fps,
			};

			this.ws.publish('/d/global', this.norms);
		});

		this.modules.obs.output.onRecordingChanged((params) => {
			const { status, time } = params;

			this.ws.publish('/d/recording', { status, time });
		});

		this.modules.obs.output.onStreamChanged((params) => {
			const { status, time, skipped, bandwidth, server } = params;

			this.ws.publish('/d/streaming', {
				status,
				time,
				skipped,
				bandwidth,
				server,
			});
		});

		this.ws.publish('/d/scenes', []);
	}

	private setupDataSourcesMacros() {
		this.macros.onMasterExecutorChange((param) => {
			const { macro } = param;
			this.ws.publish('/d/macros/master', this.macroMap(macro, 0, 0));
		});

		this.macros.onExecutorChange((param) => {
			const { macro, pageNumber, executorNumber } = param;
			this.ws.publish(
				`/d/macros/${executorNumber}`,
				this.macroMap(macro, pageNumber, executorNumber),
			);
		});

		this.publishInitialMacos();
	}

	public setup(): Promise<void> {
		this.keyboard.onRateChange((params) => {
			const { push, direction } = params;
			if (push) {
				let selectRate: TRateTypes = 'master';
				switch (this.rateSelected) {
					case 'master':
						selectRate = 'obs';
						break;
					case 'obs':
						selectRate = 'dsk1';
						break;
					case 'dsk1':
						selectRate = 'dsk2';
						break;
					case 'dsk2':
						selectRate = 'master';
						break;
					default:
						selectRate = 'master';
				}
				this.rateSelected = selectRate;
			}
			if (direction) {
				switch (this.rateSelected) {
					case 'obs':
						this.modules.obs.scene.rate(this.currentRates.obs + direction);
						break;
					case 'master':
						this.modules.atem.mix.rate(this.currentRates.master + direction);
						break;
					case 'dsk1':
						this.modules.atem.dsk.rate({
							dsk: 1,
							rate: this.currentRates.dsk1 + direction,
						});
						break;
					case 'dsk2':
						this.modules.atem.dsk.rate({
							dsk: 2,
							rate: this.currentRates.dsk1 + direction,
						});
						break;
					default:
						this.modules.atem.mix.rate(this.currentRates.master + direction);
				}
			}

			this.ws.publish('/d/trans-rate', this.buildRatesAnswer({}));
		});

		this.modules.status.onUpdate((params) => {
			this.ws.publish('/d/usage', params);
		});

		this.keyboard.setup();

		this.setupActions();

		this.setupDataSourcesMixer();
		this.setupDataSourcesObs();
		this.setupDataSourcesMacros();
		this.publishGlobalSettings();

		this.ws.publish('/d/calendar', { showStart: this.showTime });
		this.ws.publish('/d/module-connection', this.connectionStatus);

		this.config.onSaveCallback(() => {
			this.ws.publish('/d/message', {
				date: new Date(),
				message: 'Config Saved',
				type: 'green',
			});
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		process.on('unhandledRejection', (error: any) => {
			// Will print "unhandledRejection err is not defined"
			const msg =
				error?.reason ?? (error ? String(error) : 'Unknown Server Error');
			console.log(error, msg);
			this.ws.publish('/d/message', {
				date: new Date(),
				message: msg,
				type: 'banner-yellow',
			});
		});

		return Promise.resolve();
	}
}
