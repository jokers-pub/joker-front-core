import { AST, EXPRESSHANDLERTAG } from "@joker.front/ast";
import { isPlainObject, foEachProperties, guid } from "@joker.front/shared";
import { defineObserverProperty, isObserverData } from "../../observer";
import { ObType } from "../index";
import { IParser } from "../parser";
import { VNode } from "../vnode";

/**
 * For循环专用表达式运行方法
 */
function createExpress(letKey: string, keyVal: string, condition: string): Function {
    try {
        return new Function(EXPRESSHANDLERTAG, `${EXPRESSHANDLERTAG}.${letKey}=${keyVal}; return ${condition};`);
    } catch {
        throw new Error(
            `For循环命令，表达式运行依赖采集出现未知错误，其中letKey:${letKey},keyVal:${keyVal},condition:${condition}`
        );
    }
}

export class ParserList extends IParser<AST.ForCommand, VNode.List> {
    public async parser() {
        this.node = new VNode.List(this.parent);

        this.appendNode();

        await this.renderChildrens();
    }

    private async renderChildrens() {
        this.renderId = guid();
        switch (this.ast.keyType) {
            case "condition":
                await this.renderConditionChildrens();
                break;
            case "in":
            case "of":
                await this.renderInOrOfChildrens();
                break;
        }
    }

    private async renderConditionChildrens() {
        let param = this.ast.param as AST.ConditionParam;

        let forOb = Object.create(this.ob);

        /**
         * 此处采用自定义表达式方法目的是：
         *
         * 此处存在两个依赖采集点，分别是：defaultKeyVal和condition
         * 这两个采集点可能存在依赖点重叠，如果重叠则会造成重复遍历
         * 为了解决此问题，将创建一个复合表达式，对齐进行统一采集
         *
         * 该方法会设置一次默认值，并且返回首次的判断结果
         */
        let breakVal = !!this.runExpressWithWatcher(
            createExpress(param.letKey, param.defaultKeyVal, param.condition),
            forOb,
            () => {
                //每次都需要重新观察
                this.clearWatchers();
                this.renderChildrens();
            },
            true
        );

        let execRender = async (renderId?: string) => {
            let index = 0;
            let renderPrimaryArr: Array<Promise<any>> = [];
            while (breakVal) {
                //每次都要创新新的对象，因为对象是引用类型，不可以公用一个对象传递
                //如果挂载的新属性都是作为渲染，则可以用同一个属性传递
                //但是我们的属性可能会存在于一些延时触发的事件中
                let stepOb = Object.create(this.ob);

                //设置数据劫持属性
                defineObserverProperty(stepOb, param.letKey, forOb[param.letKey]);

                let currentIndex = index++;

                let result = this.renderItem(stepOb, currentIndex);

                let nextExec = () => {
                    if (this.renderId !== renderId) return;
                    this.runExpressWithWatcher(
                        () => forOb[param.letKey],
                        forOb,
                        (newVal, _, isEqual, watcher) => {
                            //通过异步等待，防止数组变更后带来的整个列表重新计算
                            Promise.resolve().then(() => {
                                if (watcher.isDestroy) return;
                                stepOb[param.letKey!] = newVal;
                                if (!isEqual) {
                                    this.updateListItemOb(stepOb, currentIndex);
                                }
                            });
                        },
                        true
                    );
                };
                if (result instanceof Promise) {
                    renderPrimaryArr.push(result.then(() => nextExec()));
                } else {
                    nextExec();
                }

                //执行下一次循环设值
                this.runExpress(param.step, forOb);
                //读取下一次的判断条件
                breakVal = !!this.runExpress(param.condition, forOb);
            }

            if (renderPrimaryArr.length) {
                await Promise.all(renderPrimaryArr).then(() => {
                    if (this.renderId !== renderId) return;
                    this.destroyOldChildrens(index);
                });
            } else {
                if (this.renderId !== renderId) return;
                this.destroyOldChildrens(index);
            }
        };

        await execRender(this.renderId);
    }

    renderId?: string;

    private async renderInOrOfChildrens() {
        let param = this.ast.param as AST.InOrOfParam;

        let listOb = this.runExpressWithWatcher(param.dataKey, this.ob, () => {
            //每次都需要重新观察
            this.clearWatchers();
            this.renderChildrens();
        });

        let execRender = async (renderId?: string) => {
            let index = 0;
            let renderPrimaryArr: Array<Promise<any>> = [];
            if (listOb && (Array.isArray(listOb) || isPlainObject(listOb))) {
                for (let key in listOb) {
                    let stepOb = Object.create(this.ob);
                    let keyVal = Array.isArray(listOb) ? Number(key) : key;
                    //对于数组时，index为索引，对于对象index为key（统称索引Key）
                    if (param.indexKey) {
                        defineObserverProperty(stepOb, param.indexKey, keyVal);
                    }

                    if (param.itemKey) {
                        defineObserverProperty(stepOb, param.itemKey, listOb[key]);
                    }
                    let currentIndex = index++;

                    let nextExec = () => {
                        if (this.renderId !== renderId) return;
                        if (param.itemKey) {
                            this.runExpressWithWatcher(
                                //@ts-ignore
                                () => listOb[keyVal],
                                listOb,
                                (newVal, _, isEqual, watcher) => {
                                    if (keyVal in listOb) {
                                        //通过异步等待，防止数组变更后带来的整个列表重新计算
                                        Promise.resolve().then(() => {
                                            if (watcher.isDestroy) return;
                                            stepOb[param.itemKey!] = newVal;
                                            if (!isEqual) {
                                                this.updateListItemOb(stepOb, currentIndex);
                                            }
                                        });
                                    }
                                },
                                true
                            );
                        }
                    };
                    let result = this.renderItem(stepOb, currentIndex, param.indexKey);

                    if (result instanceof Promise) {
                        renderPrimaryArr.push(result.then(() => nextExec()));
                    } else {
                        nextExec();
                    }
                }
            }
            if (renderPrimaryArr.length) {
                await Promise.all(renderPrimaryArr).then(() => {
                    if (this.renderId !== renderId) return;
                    this.destroyOldChildrens(index);
                });
            } else {
                if (this.renderId !== renderId) return;
                this.destroyOldChildrens(index);
            }
        };

        await execRender(this.renderId);
    }

    findIndexByIndex(ob: ObType, startIndex: number, indexKey?: string) {
        let nextIndex = -1;
        if (this.node) {
            for (let i = startIndex; i < this.node.childrens.length; i++) {
                if (this.checkObEqual(ob, this.node.childrens[i]?.ob, indexKey ? [indexKey] : undefined)) {
                    nextIndex = i;
                    break;
                }
            }
        }
        return nextIndex;
    }

    /**
     * 渲染循环项
     * @param ob
     * @param index
     */
    private renderItem(ob: ObType, index: number, indexKey?: string): any {
        if (!this.ast.childrens?.length || !this.node) {
            return;
        }

        let stepList = this.node.childrens?.[index];

        //若已经存在，则响应变更
        if (stepList) {
            if (this.checkObEqual(ob, stepList.ob, indexKey ? [indexKey] : undefined)) {
                //做一次index 同步
                if (indexKey && stepList.ob[indexKey] !== ob[indexKey]) {
                    stepList.ob[indexKey] = ob[indexKey];
                }
                return;
            }

            let nextIndex = this.findIndexByIndex(ob, index + 1, indexKey);

            if (nextIndex > -1) {
                //删除
                if (index + 1 === nextIndex) {
                    this.node.childrens?.[index]?.[VNode.PARSERKEY]?.destroy();
                } else {
                    //删除同位索引项，相同位置删除几次
                    for (let i = 0; i < nextIndex - index - 1; i++) {
                        this.node.childrens?.[index]?.[VNode.PARSERKEY]?.destroy();
                    }
                }

                return this.renderItem(ob, index, indexKey);
            } else {
                //新增
                return new ParserListeItem(this.ast, ob, this.node!, this.ext).init(index);
            }
        } else {
            return new ParserListeItem(this.ast, ob, this.node!, this.ext).init();
        }
    }

    private updateListItemOb(ob: any, index: number) {
        if (!this.ast.childrens?.length || !this.node) {
            return;
        }

        let stepList = this.node.childrens?.[index];
        foEachProperties(ob, (key: PropertyKey, val: any) => {
            //@ts-ignore
            if (stepList!.ob[key] !== val) {
                //新老值不一致时

                //设置值，做值变更通知
                //@ts-ignore
                stepList!.ob[key] = val;
            }
        });
    }
    /**
     * 销毁历史遗留多余的节点
     * @param index
     */
    private destroyOldChildrens(index: number) {
        if (!this.node) return;
        while (this.node.childrens.length > index) {
            let item = this.node!.childrens.pop();

            if (item) {
                item[VNode.PARSERKEY]?.destroy(false);
            } else {
                break;
            }
        }
    }

    private checkObEqual(newOb: ObType, oldOb?: any, excludeKey?: PropertyKey[]) {
        let equal = true;
        if (oldOb === undefined) return false;

        foEachProperties(newOb, (key: PropertyKey, val: any) => {
            if (!excludeKey?.includes(key) && oldOb?.[key] !== val) {
                equal = false;
            }
        });
        return equal;
    }
}

export class ParserListeItem extends IParser<AST.ForCommand, VNode.ListItem> {
    public async parser(index?: number) {
        this.node = new VNode.ListItem(this.ob, this.parent);

        this.appendNode(index);

        this.ast.childrens && (await this.ext.parserNodes(this.ast.childrens, this.node, this.ob));
    }
}
