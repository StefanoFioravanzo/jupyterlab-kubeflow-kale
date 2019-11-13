import * as React from "react";
import {
    INotebookTracker, Notebook,
    NotebookPanel
} from "@jupyterlab/notebook";
import NotebookUtils from "../utils/NotebookUtils";
import CellUtils from "../utils/CellUtils";
import {
    CollapsablePanel,
    MaterialInput
} from "./Components";
import { InlineCellsMetadata } from "./cell-metadata/InlineCellMetadata";
import {Cell, isCodeCellModel, CodeCell, CodeCellModel} from "@jupyterlab/cells";
import {VolumesPanel} from "./VolumesPanel";
import {SplitDeployButton} from "./DeployButton";
import {ExperimentInput} from "./ExperimentInput";
import { DeploysProgress, DeployProgressState } from "./deploys-progress/DeploysProgress";
import {JupyterFrontEnd} from "@jupyterlab/application";
import {IDocumentManager} from "@jupyterlab/docmanager";
import { KernelMessage } from "@jupyterlab/services";
import { RESERVED_CELL_NAMES } from "./cell-metadata/CellMetadataEditor";

const KALE_NOTEBOOK_METADATA_KEY = 'kubeflow_notebook';

enum RUN_CELL_STATUS {
    OK = 'ok',
    ERROR = 'error',
}

interface IRunCellResponse {
    status: string,
    cellType?: string,
    cellIndex?: number,
    ename?: string,
    evalue?: string,
}

export interface ISelectOption {
    label: string;
    value: string;
}

export interface IExperiment {
    id: string;
    name: string;
}

export const NEW_EXPERIMENT: IExperiment = {
    name: "+ New Experiment",
    id: "new"
};
const selectVolumeSizeTypes = [
    {label: "Gi", value: "Gi", base: 1024 ** 3},
    {label: "Mi", value: "Mi", base: 1024 ** 2},
    {label: "Ki", value: "Ki", base: 1024 ** 1},
    {label: "", value: "", base: 1024 ** 0},
];

const selectVolumeTypes = [
    {label: "Create Empty Volume", value: 'new_pvc'},
    {label: "Clone Notebook Volume", value: 'clone'},
    {label: "Clone Existing Snapshot", value: 'snap'},
    {label: "Use Existing Volume", value: 'pvc'},
];

interface IProps {
    lab: JupyterFrontEnd;
    tracker: INotebookTracker;
    notebook: NotebookPanel;
    docManager: IDocumentManager;
    backend: boolean;
}

interface IState {
    metadata: IKaleNotebookMetadata;
    runDeployment: boolean;
    deploymentType: string;
    deployDebugMessage: boolean;
    selectVal: string;
    activeNotebook?: NotebookPanel;
    activeCell?: Cell;
    activeCellIndex?: number;
    experiments: IExperiment[];
    gettingExperiments: boolean;
    notebookVolumes?: IVolumeMetadata[];
    volumes?: IVolumeMetadata[];
    selectVolumeTypes: {label: string, value: string}[];
    useNotebookVolumes: boolean;
    deploys: { [index: number]: DeployProgressState };
    isEnabled: boolean;
}

export interface IAnnotation {
    key: string,
    value: string
}

export interface IVolumeMetadata {
    type: string,
    // name field will have different meaning based on the type:
    //  - pv: name of the PV
    //  - pvc: name of the pvc
    //  - new_pvc: new pvc with dynamic provisioning
    //  - clone: clone a volume which is currently mounted to the Notebook Server
    //  - snap: new_pvc from Rok Snapshot
    name: string,
    mount_point: string,
    size?: number,
    size_type?: string,
    annotations: IAnnotation[],
    snapshot: boolean,
    snapshot_name?: string
}

// keep names with Python notation because they will be read
// in python by Kale.
interface IKaleNotebookMetadata {
    experiment: IExperiment;
    experiment_name: string;    // Keep this for backwards compatibility
    pipeline_name: string;
    pipeline_description: string;
    docker_image: string;
    volumes: IVolumeMetadata[];
}

interface ICompileNotebookArgs {
    source_notebook_path: string;
    notebook_metadata_overrides: Object;
    debug: boolean;
}

interface IUploadPipelineArgs {
    pipeline_package_path: string;
    pipeline_metadata: Object;
    overwrite: boolean;
}

interface IRunPipelineArgs {
    pipeline_package_path: string;
    pipeline_metadata: Object;
}

const DefaultState: IState = {
    metadata: {
        experiment: {id: '', name: ''},
        experiment_name: '',
        pipeline_name: '',
        pipeline_description: '',
        docker_image: '',
        volumes: []
    },
    runDeployment: false,
    deploymentType: 'compile',
    deployDebugMessage: false,
    selectVal: '',
    activeNotebook: null,
    activeCell: null,
    activeCellIndex: 0,
    experiments: [],
    gettingExperiments: false,
    notebookVolumes: [],
    volumes: [],
    selectVolumeTypes: selectVolumeTypes,
    useNotebookVolumes: true,
    deploys: {},
    isEnabled: false,
};

let deployIndex = 0;

const DefaultEmptyVolume: IVolumeMetadata = {
    type: 'new_pvc',
    name: '',
    mount_point: '',
    annotations: [],
    size: 1,
    size_type: 'Gi',
    snapshot: false,
    snapshot_name: '',
};

const DefaultEmptyAnnotation: IAnnotation = {
    key: '',
    value: ''
};

export class KubeflowKaleLeftPanel extends React.Component<IProps, IState> {
    // init state default values
    state = DefaultState;

    removeIdxFromArray = (index: number, arr: Array<any>): Array<any> => {return arr.slice(0, index).concat(arr.slice(index + 1, arr.length))};
    updateIdxInArray = (element: any, index: number, arr: Array<any>): Array<any> => {return arr.slice(0, index).concat([element]).concat(arr.slice(index + 1, arr.length))};

    updateSelectValue = (val: string) => this.setState({selectVal: val});
    // update metadata state values: use destructure operator to update nested dict
    updateExperiment = (experiment: IExperiment) => this.setState({metadata: {...this.state.metadata, experiment: experiment, experiment_name: experiment.name}});
    updatePipelineName = (name: string) => this.setState({metadata: {...this.state.metadata, pipeline_name: name}});
    updatePipelineDescription = (desc: string) => this.setState({metadata: {...this.state.metadata, pipeline_description: desc}});
    updateDockerImage = (name: string) => this.setState({metadata: {...this.state.metadata, docker_image: name}});
    updateVolumesSwitch = () => {
        this.setState({
            useNotebookVolumes: !this.state.useNotebookVolumes,
            volumes: this.state.notebookVolumes,
            metadata: {
                ...this.state.metadata,
                volumes: this.state.notebookVolumes,
            },
        })
    };

    // Volume managers
    deleteVolume = (idx: number) => {
        this.setState({
            volumes: this.removeIdxFromArray(idx, this.state.volumes),
            metadata: {...this.state.metadata, volumes: this.removeIdxFromArray(idx, this.state.metadata.volumes)}
        });
    };
    addVolume = () => {
        this.setState({
            volumes: [...this.state.volumes, DefaultEmptyVolume],
            metadata: {...this.state.metadata, volumes: [...this.state.metadata.volumes, DefaultEmptyVolume]}
        });
    };
    updateVolumeType = (type: string, idx: number) => {
        const kaleType: string = (type === "snap") ? "new_pvc" : type;
        const annotations: IAnnotation[] = (type === "snap") ? [{key: "rok/origin", value: ""}]: [];
        this.setState({
            volumes: this.state.volumes.map((item, key) => {return (key === idx) ? {...item, type: type, annotations: annotations}: item}),
            metadata: {...this.state.metadata, volumes: this.state.metadata.volumes.map((item, key) => {return (key === idx) ? {...item, type: kaleType, annotations: annotations}: item})}
        });
    };
    updateVolumeName = (name: string, idx: number) => {
        this.setState({
            volumes: this.state.volumes.map((item, key) => {return (key === idx) ? {...item, name: name}: item}),
            metadata: {...this.state.metadata, volumes: this.state.metadata.volumes.map((item, key) => {return (key === idx) ? {...item, name: name}: item})}
        });
    };
    updateVolumeMountPoint = (mountPoint: string, idx: number) => {
        let cloneVolume: IVolumeMetadata = null;
        if (this.state.volumes[idx].type === "clone") {
            cloneVolume = this.state.notebookVolumes.filter(v => v.mount_point === mountPoint)[0];
        }
        const updateItem = (item: IVolumeMetadata, key: number): IVolumeMetadata => {
            if (key === idx) {
                if (item.type === "clone") {
                    return {...cloneVolume};
                } else {
                    return {...this.state.volumes[idx], mount_point: mountPoint};
                }
            } else {
                return item;
            }
        };
        this.setState({
            volumes: this.state.volumes.map((item, key) => {return updateItem(item, key)}),
            metadata: {
                ...this.state.metadata,
                volumes: this.state.metadata.volumes.map((item, key) => {return updateItem(item, key)})
            }
        });
    };
    updateVolumeSnapshot = (idx: number) => {
        this.setState({
            volumes: this.state.volumes.map((item, key) => {return (key === idx) ? {...this.state.volumes[idx], snapshot: !this.state.volumes[idx].snapshot}: item}),
            metadata: {...this.state.metadata, volumes: this.state.metadata.volumes.map((item, key) => {return (key === idx) ? {...this.state.metadata.volumes[idx], snapshot: !this.state.metadata.volumes[idx].snapshot}: item})}
        });
    };
    updateVolumeSnapshotName = (name: string, idx: number) => {
        this.setState({
            volumes: this.state.volumes.map((item, key) => {return (key === idx) ? {...this.state.volumes[idx], snapshot_name: name}: item}),
            metadata: {...this.state.metadata, volumes: this.state.metadata.volumes.map((item, key) => {return (key === idx) ? {...this.state.metadata.volumes[idx], snapshot_name: name}: item})}
        });
    };
    updateVolumeSize = (size: number, idx: number) => {
        this.setState({
            volumes: this.state.volumes.map((item, key) => {return (key === idx) ? {...this.state.volumes[idx], size: size}: item}),
            metadata: {...this.state.metadata, volumes: this.state.metadata.volumes.map((item, key) => {return (key === idx) ? {...this.state.metadata.volumes[idx], size: size}: item})}
        });
    };
    updateVolumeSizeType = (sizeType: string, idx: number) => {
        this.setState({
            volumes: this.state.volumes.map((item, key) => {return (key === idx) ? {...this.state.volumes[idx], size_type: sizeType}: item}),
            metadata: {...this.state.metadata, volumes: this.state.metadata.volumes.map((item, key) => {return (key === idx) ? {...this.state.metadata.volumes[idx], size_type: sizeType}: item})}
        });
    };
    addAnnotation = (idx: number) => {
        const updateItem = (item: IVolumeMetadata, key: number) => {
            if (key === idx) {
                return {
                    ...item,
                    annotations: [...item.annotations, DefaultEmptyAnnotation]
                };
            } else {
                return item;
            }
        };
        this.setState({
            volumes: this.state.volumes.map((item, key) => {return updateItem(item, key)}),
            metadata: {
                ...this.state.metadata,
                volumes: this.state.metadata.volumes.map((item, key) => {return updateItem(item, key)})
            }
        });
    };
    deleteAnnotation = (volumeIdx: number, annotationIdx: number) => {
        const updateItem = (item: IVolumeMetadata, key: number) => {
            if (key === volumeIdx) {
                return {...item, annotations: this.removeIdxFromArray(annotationIdx, item.annotations)};
            } else {
                return item;
            }
        };
        this.setState({
            volumes: this.state.volumes.map((item, key) => {return updateItem(item, key)}),
            metadata: {
                ...this.state.metadata,
                volumes: this.state.metadata.volumes.map((item, key) => {return updateItem(item, key)})
            }
        });
    };
    updateVolumeAnnotation = (annotation: {key: string, value: string}, volumeIdx: number, annotationIdx: number) => {
        const updateItem = (item: IVolumeMetadata, key: number) => {
            if (key === volumeIdx) {
                return {
                    ...item,
                    annotations: this.updateIdxInArray(annotation, annotationIdx, item.annotations)
                };
            } else {
                return item;
            }
        };
        this.setState({
            volumes: this.state.volumes.map((item, key) => {return updateItem(item, key)}),
            metadata: {
                ...this.state.metadata,
                volumes: this.state.metadata.volumes.map((item, key) => {return updateItem(item, key)})
            }
        });
    };
    getNotebookMountPoints = (): {label: string; value: string}[] => {
        const mountPoints: {label: string, value: string}[] = [];
        this.state.notebookVolumes.map((item) => {
            mountPoints.push({label: item.mount_point, value: item.mount_point});
        });
        return mountPoints;
    };

    activateRunDeployState = (type: string) =>{ 
        if(!this.state.runDeployment){
            this.setState({runDeployment: true, deploymentType: type});
            this.runDeploymentCommand();
        }
    };

    changeDeployDebugMessage = () => this.setState({deployDebugMessage: !this.state.deployDebugMessage});


    // restore state to default values
    resetState = () => this.setState({...DefaultState, ...DefaultState.metadata});

    componentDidMount = () => {
        // Notebook tracker will signal when a notebook is changed
        this.props.tracker.currentChanged.connect(this.handleNotebookChanged, this);
        // Set notebook widget if one is open
        if (this.props.tracker.currentWidget instanceof  NotebookPanel) {
            this.setState({activeNotebook: this.props.tracker.currentWidget});
            this.setNotebookPanel(this.props.tracker.currentWidget);
            this.props.tracker.currentWidget.context.ready.then(() => {
                console.warn('ready');
                // document.querySelectorAll('.jp-Cell')
            });
        }

    };

    componentWillUnmount = () => {};

    componentDidUpdate = (prevProps: Readonly<IProps>, prevState: Readonly<IState>) => {
        // fast comparison of Metadata objects.
        // warning: this method does not work if keys change order.
        if (JSON.stringify(prevState.metadata) !== JSON.stringify(this.state.metadata)
            && this.state.activeNotebook) {
            // Write new metadata to the notebook and save
            NotebookUtils.setMetaData(
                this.state.activeNotebook,
                KALE_NOTEBOOK_METADATA_KEY,
                this.state.metadata,
                true)
        }

        // // deployment button has been pressed
        // if (prevState.runDeployment !== this.state.runDeployment && this.state.runDeployment) {
        //     this.runDeploymentCommand()
        // }
    };

    /**
    * This handles when a notebook is switched to another notebook.
    * The parameters are automatically passed from the signal when a switch occurs.
    */
    handleNotebookChanged = async (tracker: INotebookTracker, notebook: NotebookPanel) => {
        // Set the current notebook and wait for the session to be ready
        if (notebook) {
            this.setState({activeNotebook: notebook});
            await this.setNotebookPanel(notebook)
        } else {
            this.setState({activeNotebook: null});
            await this.setNotebookPanel(null)
        }
    };

    handleNotebookDisposed = async (notebookPanel: NotebookPanel) => {
        notebookPanel.disposed.disconnect(this.handleNotebookDisposed);
    };

    handleActiveCellChanged = async (notebook: Notebook, activeCell: Cell) => {
        this.setState({activeCell: activeCell, activeCellIndex: notebook.activeCellIndex});
    };

    /**
     * Read new notebook and assign its metadata to the state.
     * @param notebook active NotebookPanel
     */
    setNotebookPanel = async (notebook: NotebookPanel) => {
        // if there at least an open notebook
        if (this.props.tracker.size > 0 && notebook) {
            // wait for the session to be ready before reading metadata
            await notebook.session.ready;
            notebook.disposed.connect(this.handleNotebookDisposed);
            notebook.content.activeCellChanged.connect(this.handleActiveCellChanged);
            let currentCell = {
                activeCell: notebook.content.activeCell,
                activeCellIndex: notebook.content.activeCellIndex
            };

            // get existing notebook before we overwrite it with something else
            const notebookMetadata = NotebookUtils.getMetaData(
                notebook,
                KALE_NOTEBOOK_METADATA_KEY
            );
            console.log("Kubeflow metadata:");
            console.log(notebookMetadata);

            if (this.props.backend) {
                // Detect whether this is an exploration, i.e., recovery from snapshot
                const nbFileName = this.state.activeNotebook.context.path.split('/').pop();
                const exploration = await NotebookUtils.executeRpc(
                    this.state.activeNotebook,
                    'nb.explore_notebook',
                    {source_notebook_path: nbFileName}
                );
                if (exploration && exploration.is_exploration) {
                    this.clearCellOutputs(this.state.activeNotebook);
                    let runCellResponse = await this.runGlobalCells(this.state.activeNotebook);
                    if (runCellResponse.status === RUN_CELL_STATUS.OK) {
                        await this.unmarshalData(nbFileName);
                        const cell = this.getCellByStepName(this.state.activeNotebook, exploration.step_name);
                        this.selectAndScrollToCell(this.state.activeNotebook, cell);
                        currentCell = {activeCell: cell.cell, activeCellIndex: cell.index};
                        await NotebookUtils.showMessage(
                            'Notebook Exploration',
                            [`Resuming notebook at step: "${exploration.step_name}"`]
                        );
                    } else {
                        currentCell = {
                            activeCell: notebook.content.widgets[runCellResponse.cellIndex],
                            activeCellIndex: runCellResponse.cellIndex,
                        };
                        await NotebookUtils.showMessage(
                            'Notebook Exploration',
                            [
                                `Executing "${runCellResponse.cellType}" cell failed.\n` +
                                    `Resuming notebook at cell index ${runCellResponse.cellIndex}.`,
                                `Error name: ${runCellResponse.ename}`,
                                `Error value: ${runCellResponse.evalue}`
                            ],
                        );
                    }
                    await NotebookUtils.executeRpc(
                        this.state.activeNotebook,
                        'nb.remove_marshal_dir',
                        {source_notebook_path: nbFileName}
                    );
                }

                await this.getExperiments();
                // Get information about volumes currently mounted on the notebook server
                await this.getMountedVolumes();
                // Detect the base image of the current Notebook Server
                await this.getBaseImage();
            }

            // if the key exists in the notebook's metadata
            if (notebookMetadata) {
                let experiment: IExperiment = {id: '', name: ''};
                let experiment_name: string = '';
                if (notebookMetadata['experiment']) {
                    experiment = {
                        id: notebookMetadata['experiment']['id'] || '',
                        name: notebookMetadata['experiment']['name'] || '',
                    };
                    experiment_name = notebookMetadata['experiment']['name'];
                } else if (notebookMetadata['experiment_name']) {
                    const matchingExperiments = this.state.experiments.filter(e => e.name === notebookMetadata['experiment_name']);
                    if (matchingExperiments.length > 0) {
                        experiment = matchingExperiments[0];
                    } else {
                        experiment = {id: NEW_EXPERIMENT.id, name: notebookMetadata['experiment_name']};
                    }
                    experiment_name = notebookMetadata['experiment_name'];
                }

                let useNotebookVolumes = true;
                let metadataVolumes = (notebookMetadata['volumes'] || []).filter((v: IVolumeMetadata) => v.type !== 'clone');
                let stateVolumes = metadataVolumes.map((volume: IVolumeMetadata) => {
                    if (volume.type === 'new_pvc' && volume.annotations.length > 0 && volume.annotations[0].key === 'rok/origin') {
                        return {...volume, type: 'snap'};
                    }
                    return volume;
                });
                if (stateVolumes.length === 0 && metadataVolumes.length === 0) {
                    metadataVolumes = stateVolumes = this.state.notebookVolumes;
                } else {
                    useNotebookVolumes = false;
                    metadataVolumes = metadataVolumes.concat(this.state.notebookVolumes);
                    stateVolumes = stateVolumes.concat(this.state.notebookVolumes);
                }

                let metadata: IKaleNotebookMetadata = {
                    experiment: experiment,
                    experiment_name: experiment_name,
                    pipeline_name: notebookMetadata['pipeline_name'] || '',
                    pipeline_description: notebookMetadata['pipeline_description'] || '',
                    docker_image: notebookMetadata['docker_image'] || DefaultState.metadata.docker_image,
                    volumes: metadataVolumes,
                };
                this.setState({
                    volumes: stateVolumes,
                    metadata: metadata,
                    useNotebookVolumes: useNotebookVolumes,
                    ...currentCell
                });
            } else {
                this.setState({metadata: DefaultState.metadata, ...currentCell})
            }
        }
    };

    wait = (ms:number) =>{
        return new Promise(resolve => setTimeout(resolve, ms));
    };

    runSnapshotProcedure = async (_deployIndex:number) => {
        const showSnapshotProgress = true;
        const snapshot = await this.snapshotNotebook();
        // console.warn('snapshot:',snapshot);
        const taskId = snapshot.task.id;
        let task = await this.getSnapshotProgress(taskId);
        // console.warn('task:',task);
        // console.log("Snapshotting... ", task.progress);
        this.updateDeployProgress(_deployIndex, { task, showSnapshotProgress });

        while (!['success', 'error', 'canceled'].includes(task.status)) {
            task = await this.getSnapshotProgress(taskId,1000);
            // console.log("Snapshotting... ", task.progress);
            this.updateDeployProgress(_deployIndex, { task });
        }

        if (task.status === 'success') {
            console.log("Snapshotting successful!");
            return task;
        } else if (task.status === 'error') {
            console.error("Snapshotting failed");
            console.error("Stopping the deployment...");
        } else if (task.status === 'canceled') {
            console.error("Snapshotting canceled");
            console.error("Stopping the deployment...");
        }

        return null;
    };

    updateDeployProgress = (index: number, progress: DeployProgressState) => {
        let deploy: { [index: number]: DeployProgressState };
        if (!this.state.deploys[index]) {
            deploy = { [index]: progress };
        } else {
            deploy = { [index]: { ...this.state.deploys[index], ...progress } };
        }
        this.setState({ deploys: { ...this.state.deploys, ...deploy } });
    };

    onPanelRemove = (index: number) => {
        const deploys = { ...this.state.deploys };
        deploys[index].deleted = true;
        this.setState({ deploys });
    };

    runDeploymentCommand = async () => {
        const _deployIndex = ++deployIndex;

        const metadata = JSON.parse(JSON.stringify(this.state.metadata)); // Deepcopy metadata

        if (metadata.volumes.filter((v: IVolumeMetadata) => v.type === 'clone').length > 0) {
            const task = await this.runSnapshotProcedure(_deployIndex)
            console.log(task);
            if (!task) {
                return;
            }
            metadata.volumes = await this.replaceClonedVolumes(
                task.bucket,
                task.result.event.object,
                task.result.event.version,
                metadata.volumes
            );
        }

        console.log('metadata:', metadata);

        const nbFileName = this.state.activeNotebook.context.path.split('/').pop();


        // CREATE PIPELINE
        const compileNotebookArgs: ICompileNotebookArgs = {
            source_notebook_path: nbFileName,
            notebook_metadata_overrides: metadata,
            debug: this.state.deployDebugMessage,
        };
        const compileNotebook = await NotebookUtils.executeRpc(this.state.activeNotebook, 'nb.compile_notebook', compileNotebookArgs);
        if (!compileNotebook) {
            this.setState({ runDeployment: false });
            await NotebookUtils.showMessage('Operation Failed', ['Could not compile pipeline.']);
            return;
        }
        let msg = ["Pipeline saved successfully at " + compileNotebook.pipeline_package_path];
        if (this.state.deploymentType === 'compile') {
            await NotebookUtils.showMessage('Operation Successful', msg);
        }

        // UPLOAD
        if (this.state.deploymentType === 'upload' || this.state.deploymentType === 'run') {
            // start
            this.updateDeployProgress(_deployIndex, { showUploadProgress: true });
            const uploadPipelineArgs: IUploadPipelineArgs = {
                pipeline_package_path: compileNotebook.pipeline_package_path,
                pipeline_metadata: compileNotebook.pipeline_metadata,
                overwrite: false,
            };
            let uploadPipeline = await NotebookUtils.executeRpc(this.state.activeNotebook, 'kfp.upload_pipeline', uploadPipelineArgs);
            let result = true;
            if (!uploadPipeline) {
                // stop
                // snackbar
                this.setState({ runDeployment: false });
                msg = msg.concat(['Could not upload pipeline.']);
                await NotebookUtils.showMessage('Operation Failed', msg);
                return;
            }
            if (uploadPipeline && uploadPipeline.already_exists) {
                // show dialog to ask user if they want to overwrite the existing pipeline
                result = await NotebookUtils.showYesNoDialog(
                    'Pipeline Upload Failed',
                    'Pipeline with name ' + compileNotebook.pipeline_metadata.pipeline_name + ' already exists. ' +
                    'Would you like to overwrite it?',
                );
                // OVERWRITE EXISTING PIPELINE
                if (result) {
                    uploadPipelineArgs.overwrite = true;
                    uploadPipeline = await NotebookUtils.executeRpc(this.state.activeNotebook, 'kfp.upload_pipeline', uploadPipelineArgs);
                } else {
                    this.updateDeployProgress(_deployIndex, { pipeline: false });
                }
            }
            if (uploadPipeline && result) {
                // stop
                // link: /_/pipeline/#/pipelines/details/<id>
                // id = uploadPipeline.pipeline.id
                this.updateDeployProgress(_deployIndex, { pipeline: uploadPipeline });
                msg = msg.concat(['Pipeline with name ' + uploadPipeline.pipeline.name + ' uploaded successfully.']);
                if (this.state.deploymentType === 'upload') {
                    await NotebookUtils.showMessage('Operation Successful', msg);
                }
            }
        }

        // RUN
        if (this.state.deploymentType === 'run') {
            // start
            this.updateDeployProgress(_deployIndex, { showRunProgress: true });
            const runPipelineArgs: IRunPipelineArgs = {
                pipeline_package_path: compileNotebook.pipeline_package_path,
                pipeline_metadata: compileNotebook.pipeline_metadata,
            };
            const runPipeline = await NotebookUtils.executeRpc(this.state.activeNotebook, 'kfp.run_pipeline', runPipelineArgs);
            if (runPipeline) {
                this.updateDeployProgress(_deployIndex, { runPipeline });
                this.pollRun(_deployIndex,runPipeline);
                // TODO: get runPipeline.status
                // link: /_/pipeline/#/runs/details/<id>
                // id = runPipeline.id
                msg = msg.concat(['Pipeline run created successfully']);
                await NotebookUtils.showMessage('Operation Successful', msg);
            } else {
                msg = msg.concat(['Could not create run.']);
                await NotebookUtils.showMessage('Operation Failed', msg);
            }
        }
        // stop deploy button icon spin
        this.setState({ runDeployment: false });
    };

    pollRun(_deployIndex: number, runPipeline: any) {
        NotebookUtils.executeRpc(this.state.activeNotebook, 'kfp.get_run', {run_id: runPipeline.id})
            .then((run) => {
                this.updateDeployProgress(_deployIndex, {runPipeline: run});
                if (run && (run.status === 'Running' || run.status === null)) {
                    setTimeout(() => this.pollRun(_deployIndex, run), 2000)
                }
            });
    }

    getExperiments = async () => {
        this.setState({gettingExperiments: true});
        const list_experiments: IExperiment[] = await NotebookUtils.executeRpc(this.state.activeNotebook,"kfp.list_experiments", {});
        if (list_experiments) {
            this.setState({experiments: list_experiments.concat([NEW_EXPERIMENT])});
        } else {
            this.setState({experiments: [NEW_EXPERIMENT]});
        }

        // Fix experiment metadata
        let selectedExperiments: IExperiment[] = this.state.experiments.filter(
            e => (
                e.id === this.state.metadata.experiment.id
                || e.name === this.state.metadata.experiment.name
                || e.name === this.state.metadata.experiment_name
            )
        );
        if (selectedExperiments.length === 0 || selectedExperiments[0].id === NEW_EXPERIMENT.id) {
            let name = this.state.experiments[0].name;
            if (name === NEW_EXPERIMENT.name) {
                name = (this.state.metadata.experiment.name !== '') ?
                    this.state.metadata.experiment.name
                    : this.state.metadata.experiment_name;
            }
            this.updateExperiment({
                ...this.state.experiments[0],
                name: name,
            });
        } else {
            this.updateExperiment(selectedExperiments[0]);
        }

        this.setState({gettingExperiments: false});
    };

    getMountedVolumes = async () => {
        let notebookVolumes: IVolumeMetadata[] = await NotebookUtils.executeRpc(this.state.activeNotebook, "nb.list_volumes");

        if (notebookVolumes) {
            notebookVolumes = notebookVolumes.map((volume) => {
                const sizeGroup = selectVolumeSizeTypes.filter(s => volume.size >= s.base)[0];
                volume.size = Math.ceil(volume.size / sizeGroup.base);
                volume.size_type = sizeGroup.value;
                volume.annotations = [];
                return volume;
            });
            DefaultState.metadata.volumes = notebookVolumes;
            this.setState({
                notebookVolumes: notebookVolumes,
                selectVolumeTypes: selectVolumeTypes,
            });
        } else {
            this.setState({selectVolumeTypes: selectVolumeTypes.filter(t => t.value !== 'clone')});
        }
    };

    getBaseImage = async () => {
        let baseImage: string = await NotebookUtils.executeRpc(this.state.activeNotebook, "nb.get_base_image");
        if (baseImage) {
            DefaultState.metadata.docker_image = baseImage
        } else {
            DefaultState.metadata.docker_image = ''
        }
    };

    snapshotNotebook = async () => {
        return await NotebookUtils.executeRpc(this.state.activeNotebook, "rok.snapshot_notebook");
    };

    getSnapshotProgress = async (task_id: string, ms?: number) => {
        const task = await NotebookUtils.executeRpc(this.state.activeNotebook, "rok.get_task", {task_id});
        if (ms) {
            await this.wait(ms);
        }
        return task
    };

    replaceClonedVolumes = async (
        bucket: string,
        obj: string,
        version: string,
        volumes: IVolumeMetadata[]
    ) => {
        return await NotebookUtils.executeRpc(
            this.state.activeNotebook,
            "rok.replace_cloned_volumes",
            {bucket, obj, version, volumes}
        );
    };

    unmarshalData = async (nbFileName: string) => {
        const cmd: string = `from kale.rpc.nb import unmarshal_data as __kale_rpc_unmarshal_data\n`
            + `locals().update(__kale_rpc_unmarshal_data("${nbFileName}"))`;
        console.log("Executing command: " + cmd);
        await NotebookUtils.sendKernelRequestFromNotebook(this.state.activeNotebook, cmd, {});
    };

    getStepName = (notebook: NotebookPanel, index: number): string => {
        const names: string[] = (CellUtils.getCellMetaData(
            notebook.content,
            index,
            'tags'
        ) || []).filter((t: string) => !t.startsWith('prev:')
        ).map((t: string) => t.replace('block:', ''));
        return names.length > 0 ? names[0]: '';
    };

    clearCellOutputs = (notebook: NotebookPanel): void => {
        for (let i = 0; i < notebook.model.cells.length; i++) {
            if (!isCodeCellModel(notebook.model.cells.get(i))) {
                continue;
            }
            (notebook.model.cells.get(i) as CodeCellModel).executionCount = null;
            (notebook.model.cells.get(i) as CodeCellModel).outputs.clear();
        }
    };

    selectAndScrollToCell = (notebook: NotebookPanel, cell: {cell: Cell; index: number}): void => {
        notebook.content.select(cell.cell);
        notebook.content.activeCellIndex = cell.index;
        this.setState({activeCellIndex: cell.index, activeCell: cell.cell});
        const cellPosition = (notebook.content.node.childNodes[cell.index] as HTMLElement).getBoundingClientRect();
        notebook.content.scrollToPosition(cellPosition.top);
    };

    runGlobalCells = async (notebook: NotebookPanel): Promise<IRunCellResponse> => {
        for (let i = 0; i < notebook.model.cells.length; i++) {
            if (!isCodeCellModel(notebook.model.cells.get(i))) {
                continue;
            }
            const blockName = this.getStepName(notebook, i);
            // If a cell of that type is found, run that
            // and all consequent cells getting merged to that one
            if (blockName !== 'skip' && RESERVED_CELL_NAMES.includes(blockName)) {
                while (i < notebook.model.cells.length) {
                    const cellName = this.getStepName(notebook, i);
                    if (cellName !== blockName && cellName !== '') {
                        break;
                    }
                    this.selectAndScrollToCell(notebook, {cell: notebook.content.widgets[i], index: i});
                    const kernelMsg = await CodeCell.execute(notebook.content.widgets[i] as CodeCell, notebook.session) as KernelMessage.IExecuteReplyMsg;
                    if (kernelMsg.content && kernelMsg.content.status === 'error') {
                        return {
                            status: 'error',
                            cellType: blockName,
                            cellIndex: i,
                            ename: kernelMsg.content.ename,
                            evalue: kernelMsg.content.evalue,
                        };
                    }
                    i++;
                }
            }
        }
        return {status: 'ok'};
    };

    getCellByStepName = (notebook: NotebookPanel, stepName: string): { cell: Cell; index: number } => {
        for (let i = 0; i < notebook.model.cells.length; i++) {
            const name = this.getStepName(notebook, i);
            if (name === stepName) {
                return { cell: notebook.content.widgets[i], index: i };
            }
        }
    }

    onMetadataEnable = (isEnabled: boolean) => {
        this.setState({ isEnabled });
    }

    render() {

        // FIXME: What about human-created Notebooks? Match name and old API as well
        const selectedExperiments: IExperiment[] = this.state.experiments.filter(
            e => (
                e.id === this.state.metadata.experiment.id
                || e.name === this.state.metadata.experiment.name
                || e.name === this.state.metadata.experiment_name
            )
        );
        if (this.state.experiments.length > 0 && selectedExperiments.length === 0) {
            selectedExperiments.push(this.state.experiments[0]);
        }
        let experimentInputSelected = '';
        let experimentInputValue = ''
        if (selectedExperiments.length > 0) {
            experimentInputSelected = selectedExperiments[0].id;
            if (selectedExperiments[0].id === NEW_EXPERIMENT.id) {
                if (this.state.metadata.experiment.name !== '') {
                    experimentInputValue = this.state.metadata.experiment.name;
                } else {
                    experimentInputValue = this.state.metadata.experiment_name;
                }
            } else {
                experimentInputValue = selectedExperiments[0].name;
            }
        }
        const experiment_name_input = <ExperimentInput
            updateValue={this.updateExperiment}
            options={this.state.experiments}
            selected={experimentInputSelected}
            value={experimentInputValue}
            loading={this.state.gettingExperiments}
        />

        const pipeline_name_input = <MaterialInput
            label={"Pipeline Name"}
            updateValue={this.updatePipelineName}
            value={this.state.metadata.pipeline_name}
            regex={"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"}
            regexErrorMsg={"Pipeline name must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character."}
        />;

        const pipeline_desc_input = <MaterialInput
            label={"Pipeline Description"}
            updateValue={this.updatePipelineDescription}
            value={this.state.metadata.pipeline_description}
        />;

        const volsPanel = <VolumesPanel
            volumes={this.state.volumes}
            addVolume={this.addVolume}
            updateVolumeType={this.updateVolumeType}
            updateVolumeName={this.updateVolumeName}
            updateVolumeMountPoint={this.updateVolumeMountPoint}
            updateVolumeSnapshot={this.updateVolumeSnapshot}
            updateVolumeSnapshotName={this.updateVolumeSnapshotName}
            updateVolumeSize={this.updateVolumeSize}
            updateVolumeSizeType={this.updateVolumeSizeType}
            deleteVolume={this.deleteVolume}
            updateVolumeAnnotation={this.updateVolumeAnnotation}
            addAnnotation={this.addAnnotation}
            deleteAnnotation={this.deleteAnnotation}
            notebookMountPoints={this.getNotebookMountPoints()}
            selectVolumeSizeTypes={selectVolumeSizeTypes}
            selectVolumeTypes={this.state.selectVolumeTypes}
            useNotebookVolumes={this.state.useNotebookVolumes}
            updateVolumesSwitch={this.updateVolumesSwitch}
        />;

        return (
            <div className={"kubeflow-widget"}>
                <div className={"kubeflow-widget-content"}>

                    <div>
                        <p style={{ fontSize: "var(--jp-ui-font-size3)" }}
                            className="kale-header">
                            Kale  Deployment  Panel {this.state.isEnabled}
                        </p>
                    </div>

                    <div className="kale-component">
                        <InlineCellsMetadata
                            onMetadataEnable={this.onMetadataEnable}
                            notebook={this.state.activeNotebook}
                            activeCellIndex={this.state.activeCellIndex}
                        />
                    </div>

                    <div className={"kale-component " + (this.state.isEnabled ? '' : 'hidden')}>
                        <div>
                            <p className="kale-header">Pipeline Metadata</p>
                        </div>

                        <div className={'input-container'}>
                            {experiment_name_input}
                            {pipeline_name_input}
                            {pipeline_desc_input}
                        </div>
                    </div>


                    {/*  CELLTAGS PANEL  */}
                    {/* <div className="kale-component"> */}
                    {/* <CellTags
                            notebook={this.state.activeNotebook}
                            activeCellIndex={this.state.activeCellIndex}
                            activeCell={this.state.activeCell}
                        /> */}
                    {/*  --------------  */}
                    {/* </div> */}

                    <div className={this.state.isEnabled ? '' : 'hidden'}>
                        {volsPanel}
                    </div>

                    <div className={"kale-component " + (this.state.isEnabled ? '' : 'hidden')}>
                        <CollapsablePanel
                            title={"Advanced Settings"}
                            dockerImageValue={this.state.metadata.docker_image}
                            dockerChange={this.updateDockerImage}
                            debug={this.state.deployDebugMessage}
                            changeDebug={this.changeDeployDebugMessage}
                        />
                    </div>
                </div>
                <div className={this.state.isEnabled ? '' : 'hidden'}
                    style={{ marginTop: 'auto' }}>
                    <DeploysProgress deploys={this.state.deploys} onPanelRemove={this.onPanelRemove} />
                    <SplitDeployButton
                        running={this.state.runDeployment}
                        handleClick={this.activateRunDeployState}
                    />
                </div>
            </div>
        );
    }
}